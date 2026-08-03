# LLM 门控回测报告

生成时间: 2026-08-03T16:55:21.462Z
模式: 双AI (Gemini primary + DeepSeek secondary, 任一skip即否决)
样本: 89 个已结算 position (跳过 0 个缺数据, advisor null 86 个)

## 核心对比: 无门控 vs AI门控

| 指标 | 无门控(全买) | AI门控(proceed才买, null放行) | 严格门控(连null也砍) |
|------|-------------|------------------------------|---------------------|
| 交易数 | 89 | 86 | 0 |
| 命中数 | 3 | 2 | 0 |
| 胜率 | 3.4% | 2.3% | 0.0% |
| 总 PnL | $-522.0 | $-511.5 | $0.0 |
| 均 PnL/笔 | $-5.86 | $-5.95 | $0.00 |

门控收益: AI门控 PnL $-511.5 vs 无门控 $-522.0 = +$10.5

## AI 砍掉的 3 笔实际表现 (判断误杀)

| 指标 | skip组 (AI砍掉) | proceed组 (AI放行) |
|------|----------------|-------------------|
| 交易数 | 3 | 86 |
| 命中数 | 1 | 2 |
| 胜率 | 33.3% | 2.3% |
| 总 PnL | $-10.5 | $-511.5 |
| 均 PnL | $-3.50 | $-5.95 |

**解读**: skip组均PnL = $-3.50
- 若为负 → AI 砍掉了亏损交易, 门控有价值
- 若为正 → AI 误杀了盈利交易, 门控有害
- 砍掉 3/89 笔 (3.4%), 其中命中 1 笔 (误杀的赢家)

## 双AI拆分

- DeepSeek secondary 单独 skip: 3 笔
- 合并 skip (任一skip): 3 笔
- 门控规则 (llm.ts:305): 任一模型 skip 即否决

## 局限 (解读时务必考虑)

1. LLM 非确定, 本报告是一次性快照, 重跑可能略变
2. 未来信息偏差: LLM 训练数据或含个别事件结果 (具体日期最高温被记住概率极低)
3. 单候选回放: 只回放开仓桶, AI 看不到当时其他候选
4. 86 个 advisor null (限流/错误) 按放行计, 可能让门控偏弱

## 逐笔 verdict

| city | date | bucket | entry | p | ev | action | risk | hit | pnl | close | reason |
|------|------|--------|-------|---|----|--------|------|-----|-----|-------|--------|
| Ankara | 2026-07-31 | 26-26C | 0.360 | 100.0% | 1.78 | skip | high | ✓ | $-4.4 | stop_loss | gemini: 模型概率(100%)存在严重计算异常，且METAR实时观测(13°C)与预报(26.3°C)极端背离。 / deepseek |
| Ankara | 2026-08-01 | 30-30C | 0.030 | 11.4% | 2.80 | null | low | ✗ | $-6.7 | stop_loss | (advisor unavailable) |
| Ankara | 2026-08-01 | 26-26C | 0.039 | 12.3% | 2.14 | null | low | ✗ | $-5.6 | stop_loss | (advisor unavailable) |
| Atlanta | 2026-07-31 | 92-93F | 0.350 | 100.0% | 1.86 | skip | high | ✗ | $-5.1 | stop_loss | gemini: 预报与桶区间高度吻合，价差合理且成交量充足，无明显数据风险。 / deepseek: 实时观测78F与预报92F极端背离，且 |
| Buenos Aires | 2026-07-31 | 24-24C | 0.110 | 100.0% | 8.09 | null | low | ✗ | $-5.5 | stop_loss | (advisor unavailable) |
| Buenos Aires | 2026-08-01 | 21-21C | 0.040 | 13.1% | 2.27 | null | low | ✗ | $-5.0 | stop_loss | (advisor unavailable) |
| Chicago | 2026-07-31 | 84-85F | 0.160 | 100.0% | 5.25 | null | low | ✗ | $-5.0 | stop_loss | (advisor unavailable) |
| Dallas | 2026-07-31 | 104-105F | 0.220 | 100.0% | 3.55 | skip | high | ✗ | $-0.9 | stop_loss | gemini: 剩余8.2小时下模型给出100%胜率且EV高达3.546，存在严重的模型概率计算失真异常。 / deepseek: 预报10 |
| Dallas | 2026-08-01 | 102-103F | 0.020 | 11.7% | 4.86 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| London | 2026-08-02 | 29-29C | 0.040 | 18.5% | 3.62 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| London | 2026-08-02 | 28-28C | 0.170 | 32.6% | 0.92 | null | low | ✗ | $-9.4 | stop_loss | (advisor unavailable) |
| London | 2026-08-02 | 29-29C | 0.040 | 18.5% | 3.62 | null | low | ✗ | $-5.0 | forecast_changed | (advisor unavailable) |
| London | 2026-08-02 | 29-29C | 0.040 | 18.5% | 3.62 | null | low | ✗ | $-5.0 | forecast_changed | (advisor unavailable) |
| London | 2026-08-02 | 29-29C | 0.040 | 18.5% | 3.62 | null | low | ✗ | $-5.0 | forecast_changed | (advisor unavailable) |
| London | 2026-08-02 | 29-29C | 0.040 | 18.5% | 3.62 | null | low | ✗ | $-17.3 | stop_loss | (advisor unavailable) |
| London | 2026-08-03 | 33-33C | 0.050 | 15.6% | 2.12 | null | low | ✗ | $-2.0 | forecast_changed | (advisor unavailable) |
| London | 2026-08-03 | 33-33C | 0.050 | 15.6% | 2.12 | null | low | ✗ | $-6.0 | forecast_changed | (advisor unavailable) |
| London | 2026-08-03 | 33-33C | 0.040 | 17.6% | 3.40 | null | low | ✗ | $-7.5 | forecast_changed | (advisor unavailable) |
| London | 2026-08-03 | 33-33C | 0.030 | 16.9% | 4.65 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| London | 2026-08-03 | 32-32C | 0.130 | 23.8% | 0.83 | null | low | ✗ | $-4.6 | stop_loss | (advisor unavailable) |
| London | 2026-08-03 | 33-33C | 0.040 | 17.4% | 3.35 | null | low | ✗ | $-16.5 | stop_loss | (advisor unavailable) |
| London | 2026-08-03 | 32-32C | 0.110 | 23.9% | 1.17 | null | low | ✗ | $-9.1 | stop_loss | (advisor unavailable) |
| Lucknow | 2026-07-31 | 32-32C | 0.420 | 100.0% | 1.38 | null | low | ✗ | $20.7 | forecast_changed | (advisor unavailable) |
| Lucknow | 2026-08-01 | 33-33C | 0.380 | 100.0% | 1.63 | null | low | ✗ | $0.3 | forecast_changed | (advisor unavailable) |
| Lucknow | 2026-08-02 | 32-32C | 0.170 | 100.0% | 4.88 | null | low | ✗ | $-0.6 | forecast_changed | (advisor unavailable) |
| Miami | 2026-07-31 | 96-97F | 0.250 | 100.0% | 3.00 | null | low | ✓ | $14.4 | forecast_changed | (advisor unavailable) |
| Munich | 2026-08-02 | 28-28C | 0.160 | 31.8% | 0.99 | null | low | ✗ | $-18.1 | stop_loss | (advisor unavailable) |
| Munich | 2026-08-02 | 28-28C | 0.160 | 31.8% | 0.99 | null | low | ✗ | $-18.1 | stop_loss | (advisor unavailable) |
| Munich | 2026-08-03 | 34-34C | 0.180 | 33.5% | 0.86 | null | low | ✗ | $-5.6 | stop_loss | (advisor unavailable) |
| Munich | 2026-08-03 | 33-33C | 0.040 | 21.9% | 4.47 | null | low | ✗ | $-5.0 | forecast_changed | (advisor unavailable) |
| Munich | 2026-08-03 | 33-33C | 0.040 | 18.7% | 3.67 | null | low | ✗ | $-2.5 | forecast_changed | (advisor unavailable) |
| Munich | 2026-08-03 | 33-33C | 0.040 | 18.7% | 3.67 | null | low | ✗ | $-2.5 | forecast_changed | (advisor unavailable) |
| Munich | 2026-08-03 | 33-33C | 0.040 | 19.5% | 3.88 | null | low | ✗ | $-7.5 | forecast_changed | (advisor unavailable) |
| Munich | 2026-08-03 | 34-34C | 0.140 | 30.8% | 1.20 | null | low | ✗ | $-5.7 | stop_loss | (advisor unavailable) |
| Munich | 2026-08-03 | 33-33C | 0.030 | 15.1% | 4.04 | null | low | ✗ | $-3.3 | forecast_changed | (advisor unavailable) |
| Munich | 2026-08-03 | 34-34C | 0.100 | 31.8% | 2.18 | null | low | ✗ | $-1.0 | stop_loss | (advisor unavailable) |
| Munich | 2026-08-03 | 34-34C | 0.100 | 32.2% | 2.22 | null | low | ✗ | $-13.0 | stop_loss | (advisor unavailable) |
| New York City | 2026-07-31 | 86-87F | 0.380 | 100.0% | 1.63 | null | low | ✗ | $-11.1 | stop_loss | (advisor unavailable) |
| New York City | 2026-08-01 | 86-87F | 0.440 | 100.0% | 1.27 | null | low | ✓ | $-4.5 | stop_loss | (advisor unavailable) |
| Paris | 2026-07-31 | 28-28C | 0.170 | 100.0% | 4.88 | null | low | ✗ | $-5.9 | stop_loss | (advisor unavailable) |
| Paris | 2026-08-01 | 30-30C | 0.020 | 12.7% | 5.33 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| Paris | 2026-08-03 | 37-37C | 0.160 | 29.6% | 0.85 | null | low | ✗ | $13.1 | forecast_changed | (advisor unavailable) |
| Paris | 2026-08-03 | 38-38C | 0.060 | 16.8% | 1.79 | null | low | ✗ | $-1.7 | forecast_changed | (advisor unavailable) |
| Paris | 2026-08-03 | 34-34C | 0.030 | 18.6% | 5.20 | null | low | ✗ | $-10.0 | forecast_changed | (advisor unavailable) |
| Paris | 2026-08-03 | 34-34C | 0.030 | 20.2% | 5.72 | null | low | ✗ | $23.3 | forecast_changed | (advisor unavailable) |
| Paris | 2026-08-03 | 35-35C | 0.190 | 33.1% | 0.74 | null | low | ✗ | $-8.4 | stop_loss | (advisor unavailable) |
| Paris | 2026-08-03 | 35-35C | 0.160 | 27.9% | 0.74 | null | low | ✗ | $-1.3 | stop_loss | (advisor unavailable) |
| Sao Paulo | 2026-07-31 | 24-24C | 0.420 | 100.0% | 1.38 | null | low | ✗ | $-1.7 | stop_loss | (advisor unavailable) |
| Sao Paulo | 2026-08-01 | 29-29C | 0.040 | 14.3% | 2.57 | null | low | ✗ | $-5.0 | stop_loss | (advisor unavailable) |
| Sao Paulo | 2026-08-02 | 28-28C | 0.370 | 100.0% | 1.70 | null | low | ✗ | $-0.8 | forecast_changed | (advisor unavailable) |
| Seattle | 2026-08-01 | 68-69F | 0.140 | 100.0% | 6.14 | null | low | ✗ | $-0.7 | forecast_changed | (advisor unavailable) |
| Seoul | 2026-08-01 | 30-30C | 0.100 | 100.0% | 9.00 | null | low | ✗ | $-4.0 | stop_loss | (advisor unavailable) |
| Seoul | 2026-08-02 | 31-31C | 0.250 | 100.0% | 3.00 | null | low | ✗ | $-4.4 | stop_loss | (advisor unavailable) |
| Shanghai | 2026-08-02 | 35-35C | 0.240 | 100.0% | 3.17 | null | low | ✗ | $-5.4 | stop_loss | (advisor unavailable) |
| Shanghai | 2026-08-03 | 33-33C | 0.060 | 32.3% | 4.38 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| Shanghai | 2026-08-03 | 33-33C | 0.080 | 23.1% | 1.89 | null | low | ✗ | $-11.3 | stop_loss | (advisor unavailable) |
| Shanghai | 2026-08-03 | 33-33C | 0.050 | 33.6% | 5.73 | null | low | ✗ | $0.0 | trailing_stop | (advisor unavailable) |
| Singapore | 2026-08-02 | 30-30C | 0.020 | 10.5% | 4.28 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| Singapore | 2026-08-02 | 31-31C | 0.200 | 30.7% | 0.53 | null | low | ✗ | $-16.5 | stop_loss | (advisor unavailable) |
| Singapore | 2026-08-02 | 31-31C | 0.200 | 30.7% | 0.53 | null | low | ✗ | $-16.5 | stop_loss | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.090 | 18.5% | 1.05 | null | low | ✗ | $-10.0 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.050 | 16.8% | 2.35 | null | low | ✗ | $-8.0 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.040 | 16.8% | 3.19 | null | low | ✗ | $-2.5 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.040 | 15.1% | 2.78 | null | low | ✗ | $-2.5 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.040 | 15.1% | 2.78 | null | low | ✗ | $2.5 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.050 | 15.1% | 2.03 | null | low | ✗ | $-10.0 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.030 | 15.1% | 4.04 | null | low | ✗ | $3.3 | forecast_changed | (advisor unavailable) |
| Singapore | 2026-08-03 | 31-31C | 0.070 | 18.5% | 1.64 | null | low | ✗ | $-10.0 | forecast_changed | (advisor unavailable) |
| Tokyo | 2026-08-01 | 33-33C | 0.110 | 100.0% | 8.09 | null | low | ✗ | $-19.9 | stop_loss | (advisor unavailable) |
| Tokyo | 2026-08-02 | 31-31C | 0.030 | 24.5% | 7.16 | null | low | ✗ | $-13.3 | stop_loss | (advisor unavailable) |
| Tokyo | 2026-08-02 | 32-32C | 0.040 | 19.5% | 3.88 | null | low | ✗ | $-19.8 | stop_loss | (advisor unavailable) |
| Tokyo | 2026-08-03 | 25-25C | 0.030 | 14.2% | 3.74 | null | low | ✗ | $-6.7 | forecast_changed | (advisor unavailable) |
| Tokyo | 2026-08-03 | 26-26C | 0.160 | 27.5% | 0.72 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| Tokyo | 2026-08-03 | 26-26C | 0.110 | 26.2% | 1.38 | null | low | ✗ | $-19.9 | stop_loss | (advisor unavailable) |
| Toronto | 2026-07-31 | 31-31C | 0.250 | 100.0% | 3.00 | null | low | ✗ | $-5.6 | stop_loss | (advisor unavailable) |
| Toronto | 2026-08-01 | 31-31C | 0.030 | 13.1% | 3.35 | null | low | ✗ | $-6.7 | stop_loss | (advisor unavailable) |
| Wellington | 2026-08-02 | 11-11C | 0.040 | 11.1% | 1.76 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| Wellington | 2026-08-02 | 11-11C | 0.040 | 25.2% | 5.31 | null | low | ✗ | $-10.0 | stop_loss | (advisor unavailable) |
| Wellington | 2026-08-02 | 11-11C | 0.040 | 25.2% | 5.31 | null | low | ✗ | $-19.8 | stop_loss | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.050 | 20.2% | 3.03 | null | low | ✗ | $0.0 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.060 | 20.2% | 2.36 | null | low | ✗ | $-10.0 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.040 | 20.2% | 4.04 | null | low | ✗ | $-5.0 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.040 | 20.2% | 4.04 | null | low | ✗ | $-5.0 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.040 | 21.9% | 4.47 | null | low | ✗ | $5.0 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.080 | 18.5% | 1.31 | null | low | ✗ | $-7.5 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.060 | 16.8% | 1.79 | null | low | ✗ | $-10.0 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.040 | 16.8% | 3.19 | null | low | ✗ | $17.5 | forecast_changed | (advisor unavailable) |
| Wellington | 2026-08-03 | 15-15C | 0.210 | 31.8% | 0.51 | null | low | ✗ | $-6.7 | stop_loss | (advisor unavailable) |
| Wellington | 2026-08-03 | 14-14C | 0.070 | 16.8% | 1.40 | null | low | ✗ | $-15.7 | stop_loss | (advisor unavailable) |
