import { type CountryLayoutDef, type CountryTierDef, countryLayoutSchema, countryTierSchema } from '../../human/tiers';
import type { CountryPattern } from '../../human/countries/patterns';
import { countryPatternSchema } from '../../human/countries/patterns/index';
import patterns from './patterns.json';
import data from './tiers.json';

// 内置的国家等级与格局（第四十二轮，格式见 human/tiers.ts）：在每个库的“国家等级”里，新建世界时默认加进去。
// 五档的 id、数值与第四十一轮之前写死在 countries.ts 的一样（面积倍数、时代没写时的比例、相配的政体、当附庸、联邦、邦联），
// 用它生成的世界与以前逐值相同；名字参照欧陆风云的帝国级、王国级、公国级行政，另加侯国级、城邦级。只在主线程用

export const BUILTIN_COUNTRY_TIERS: readonly CountryTierDef[] = data.tiers.map((t) => countryTierSchema.parse(t));
export const BUILTIN_COUNTRY_LAYOUTS: readonly CountryLayoutDef[] = data.layouts.map((l) => countryLayoutSchema.parse(l));

// 内置的国家格局（第七十三轮，格式见 human/countries/patterns/index.ts）：六个时代以前写在 relations 里的邦联、联邦、同盟的多少与附庸的种类。
// 放在每个库的“时代”小包里（用到的那几种），时代加进世界时一起来；神圣帝国、联邦、军事同盟几个库共用，多少写在时代里
export const BUILTIN_COUNTRY_PATTERNS: readonly CountryPattern[] = patterns.patterns.map((p) => countryPatternSchema.parse(p));
