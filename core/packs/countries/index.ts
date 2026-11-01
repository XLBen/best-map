import { type CountryLayoutDef, type CountryTierDef, countryLayoutSchema, countryTierSchema } from '../../human/tiers';
import data from './tiers.json';

// 内置的国家等级与格局（第四十二轮，格式见 human/tiers.ts）：在“通用 ▸ 国家等级”里，新建世界时默认加进去。
// 五档的 id、数值与第四十一轮之前写死在 countries.ts 的一样（面积倍数、时代没写时的比例、相配的政体、当附庸、联邦、邦联），
// 用它生成的世界与以前逐值相同；名字参照欧陆风云的帝国级、王国级、公国级行政，另加侯国级、城邦级。只在主线程用

export const BUILTIN_COUNTRY_TIERS: readonly CountryTierDef[] = data.tiers.map((t) => countryTierSchema.parse(t));
export const BUILTIN_COUNTRY_LAYOUTS: readonly CountryLayoutDef[] = data.layouts.map((l) => countryLayoutSchema.parse(l));
