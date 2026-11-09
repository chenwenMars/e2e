import { validDate, type Currency, type ExchangeRate } from '../src/domain.ts';

/** Read the latest published ECB reference rate for one unit of the settlement currency. */
export async function latestRate(base: Currency): Promise<ExchangeRate> {
  const response = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/CNY?providers=ECB`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`获取 ${base} 汇率失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (data.base !== base || data.quote !== 'CNY' || !validDate(data.date) ||
      typeof data.rate !== 'number' || !Number.isFinite(data.rate) || data.rate <= 0)
    throw new Error(`汇率服务返回了无效的 ${base}/CNY 报价`);
  return { base, date: data.date, rate: data.rate };
}
