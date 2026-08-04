import {
  ECMWF_BIAS_C,
  ECMWF_BIAS_F,
  ENSEMBLE_MODELS,
  ENSEMBLE_WEIGHTS,
  LLM_ENSEMBLE,
  TIMEZONES,
  type LocationInfo,
} from "./config.js";
import { fetchJson, sleep } from "./http.js";
import { getBias } from "./bias.js";
import { llmChat, resetLlmCallBudget } from "./llm.js";

interface OpenMeteoDaily {
  daily?: Record<string, unknown> & { time?: string[] };
  error?: boolean | string;
}

/** One day's ensemble forecast for a city. */
export interface EnsembleForecast {
  /** Per-model daily max temp in the location unit (ecmwf already bias-corrected). */
  models: Record<string, number>;
  /** Weighted ensemble mean (our best estimate). */
  mean: number;
  /** Max absolute deviation of any model from the mean (forecast uncertainty). */
  spread: number;
  /** |ecmwf - gfs| model disagreement in the location unit. */
  gap: number;
  /** Whether this forecast was LLM-enhanced (true) or weighted average (false). */
  llmEnhanced?: boolean;
  /** LLM fusion confidence (0-1), only when llmEnhanced=true. */
  llmConfidence?: number;
}

/**
 * LLM 后处理器: 调用 AI (DeepSeek) 融合多模型预报值。
 * 将 ECMWF/GFS/ICON 的原始预报 + 历史偏差 + 模型分歧度喂给 AI,
 * 让它输出更聪明的融合预测, 而不是简单加权平均。
 *
 * @param citySlug 城市标识
 * @param date 预报日期
 * @param unit 温度单位 ('C' 或 'F')
 * @param modelTemps 各模型的预报温度
 * @param spread 模型离散度 (不确定性)
 * @param gap ECMWF vs GFS 分歧度
 * @returns { mean, confidence } AI 融合预测和置信度, 失败返回 null
 */
async function llmEnsembleForecast(
  citySlug: string,
  date: string,
  unit: "C" | "F",
  modelTemps: Record<string, number>,
  spread: number,
  gap: number,
): Promise<{ mean: number; confidence: number } | null> {
  // 计算简单加权平均作为基准
  let wsum = 0;
  let msum = 0;
  for (const [model, t] of Object.entries(modelTemps)) {
    const w = ENSEMBLE_WEIGHTS[model] ?? 0;
    if (w <= 0) continue;
    wsum += w;
    msum += w * t;
  }
  const baselineMean = wsum > 0 ? msum / wsum : null;
  if (baselineMean == null) return null;

  // 构造 LLM prompt
  const modelInfo = Object.entries(modelTemps)
    .map(([model, t]) => {
      const weight = ENSEMBLE_WEIGHTS[model] ?? 0;
      const modelName =
        model === "ecmwf_ifs025"
          ? "ECMWF"
          : model === "gfs_seamless"
            ? "GFS/HRRR"
            : model === "icon_seamless"
              ? "ICON"
              : model;
      return `${modelName}: ${t.toFixed(1)}°${unit} (权重 ${(weight * 100).toFixed(0)}%)`;
    })
    .join(", ");

  const system = `你是气象预报融合专家。你的任务: 分析多个数值天气预报模型的每日最高温预报,
融合为单一的最优预测值。你需要考虑:
1. 各模型的历史准确率 (ECMWF 通常最准, GFS 次之, ICON 第三)
2. 模型间的分歧 (分歧越大, 不确定性越高)
3. 系统性偏差 (某些城市/季节模型有固定偏差)
只输出 JSON: {"temperature": 数字, "confidence": 0-1}`;

  const user = `城市: ${citySlug}
日期: ${date}
单位: °${unit}
各模型预报: ${modelInfo}
加权平均基准: ${baselineMean.toFixed(1)}°${unit}
模型分歧 spread: ${spread.toFixed(1)}°${unit}
ECMWF-GFS gap: ${gap.toFixed(1)}°${unit}

请融合以上预报, 输出 JSON 格式的最终预测温度和置信度。
温度保留一位小数, 在所有模型值范围内。置信度 0.9+ 表示高确信度, 0.7-0.9 表示中等, <0.7 表示低。`;

  try {
    resetLlmCallBudget();
    const raw = await llmChat(system, user, 0.1);
    if (!raw) {
      console.warn(`  [LLM ENSEMBLE] ${citySlug} ${date} — LLM 无响应, 使用加权平均`);
      return { mean: Math.round(baselineMean * 10) / 10, confidence: 0.7 };
    }

    // 解析 JSON 响应
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`  [LLM ENSEMBLE] ${citySlug} ${date} — 响应解析失败: ${raw.slice(0, 100)}`);
      return { mean: Math.round(baselineMean * 10) / 10, confidence: 0.7 };
    }

    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    const llmTemp = Number(parsed.temperature);
    const llmConfidence = Number(parsed.confidence) || 0.7;

    if (!Number.isFinite(llmTemp) || llmTemp < -50 || llmTemp > 60) {
      console.warn(`  [LLM ENSEMBLE] ${citySlug} ${date} — AI 输出温度异常: ${llmTemp}`);
      return { mean: Math.round(baselineMean * 10) / 10, confidence: 0.7 };
    }

    // 安全钳位: LLM 预测必须在所有模型值的 ±spread 范围内
    const allValues = Object.values(modelTemps);
    const minVal = Math.min(...allValues) - spread;
    const maxVal = Math.max(...allValues) + spread;
    const clamped = Math.max(minVal, Math.min(maxVal, llmTemp));

    console.log(
      `  [LLM ENSEMBLE] ${citySlug} ${date} — AI 融合: ${clamped.toFixed(1)}°${unit} ` +
        `(基准 ${baselineMean.toFixed(1)}, 置信度 ${llmConfidence.toFixed(2)})`,
    );

    return {
      mean: Math.round(clamped * 10) / 10,
      confidence: Math.max(0.3, Math.min(0.99, llmConfidence)),
    };
  } catch (e) {
    console.warn(`  [LLM ENSEMBLE] ${citySlug} ${date} — 调用异常: ${String(e).slice(0, 80)}`);
    return { mean: Math.round(baselineMean * 10) / 10, confidence: 0.7 };
  }
}

export async function getEnsembleForecast(
  citySlug: string,
  dates: Set<string>,
  loc: LocationInfo,
): Promise<Record<string, EnsembleForecast>> {
  const unit = loc.unit;
  const tempUnit = unit === "F" ? "fahrenheit" : "celsius";
  const result: Record<string, EnsembleForecast> = {};
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=${tempUnit}` +
    `&forecast_days=7&timezone=${encodeURIComponent(TIMEZONES[citySlug] ?? "UTC")}` +
    `&models=${ENSEMBLE_MODELS.join(",")}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJson<OpenMeteoDaily>(url);
      const daily = data.daily;
      if (!data.error && daily?.time) {
        const times = daily.time;
        // Pull each model's series, bias-correct ECMWF (horizon-aware rolling
        // bias via getBias — D+1 daily-max errors run far larger than D+0).
        const series: Record<string, (number | null)[]> = {};
        for (const model of ENSEMBLE_MODELS) {
          const raw = daily[`temperature_2m_max_${model}`];
          if (Array.isArray(raw)) series[model] = raw as (number | null)[];
        }
        const models = Object.keys(series);
        if (models.length === 0) break;

        const datesArr = Array.from(dates);
        const horizonFor = (d: string): string => {
          const idx = datesArr.indexOf(d);
          return idx >= 0 ? `D+${idx}` : "D+0";
        };
        for (let i = 0; i < times.length; i++) {
          const date = times[i];
          if (!date || !dates.has(date)) continue;
          const calBias = getBias(citySlug, horizonFor(date), "ecmwf"); // signed error (forecast - actual)
          const ecmwfBias =
            calBias !== 0 ? -calBias : unit === "C" ? ECMWF_BIAS_C : ECMWF_BIAS_F;
          const modelTemps: Record<string, number> = {};
          for (const model of models) {
            const v = series[model]?.[i];
            if (v == null) continue;
            let t = Number(v);
            if (model === "ecmwf_ifs025") t += ecmwfBias;
            modelTemps[model] = unit === "C" ? Math.round(t * 10) / 10 : Math.round(t);
          }
          if (Object.keys(modelTemps).length === 0) continue;
          // Weighted mean.
          let wsum = 0;
          let msum = 0;
          for (const [model, t] of Object.entries(modelTemps)) {
            const w = ENSEMBLE_WEIGHTS[model] ?? 0;
            if (w <= 0) continue;
            wsum += w;
            msum += w * t;
          }
          if (wsum <= 0) continue;
          let mean = msum / wsum;
          let spread = 0;
          for (const t of Object.values(modelTemps)) {
            spread = Math.max(spread, Math.abs(t - mean));
          }
          const ecmwf = modelTemps.ecmwf_ifs025;
          const gfs = modelTemps.gfs_seamless;
          const gap = ecmwf != null && gfs != null ? Math.abs(ecmwf - gfs) : 0;

          // LLM 融合模式: 如果启用, 尝试用 AI 融合预报
          let llmEnhanced = false;
          let llmConfidence: number | undefined;
          if (LLM_ENSEMBLE && Object.keys(modelTemps).length >= 2) {
            const llmResult = await llmEnsembleForecast(
              citySlug,
              date,
              unit,
              modelTemps,
              spread,
              gap,
            );
            if (llmResult) {
              mean = llmResult.mean;
              llmEnhanced = true;
              llmConfidence = llmResult.confidence;
            }
          }

          result[date] = {
            models: modelTemps,
            mean: Math.round(mean * 10) / 10,
            spread: Math.round(spread * 10) / 10,
            gap: Math.round(gap * 10) / 10,
            llmEnhanced,
            llmConfidence,
          };
        }
      }
      break;
    } catch (e) {
      if (attempt < 2) await sleep(3000);
      else console.error(`  [ENSEMBLE] ${citySlug}:`, e);
    }
  }
  return result;
}

interface MetarRow {
  temp?: number | string | null;
}

export async function getMetar(citySlug: string, loc: LocationInfo): Promise<number | null> {
  const station = loc.station;
  const unit = loc.unit;
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`;
    const data = await fetchJson<MetarRow[]>(url);
    if (data && Array.isArray(data)) {
      const tempC = data[0]?.temp;
      if (tempC != null) {
        if (unit === "F") return Math.round(Number(tempC) * (9 / 5) + 32);
        return Math.round(Number(tempC) * 10) / 10;
      }
    }
  } catch (e) {
    console.error(`  [METAR] ${citySlug}:`, e);
  }
  return null;
}

