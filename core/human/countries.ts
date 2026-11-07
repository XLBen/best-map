// 国家（第二十三轮）。第七十三轮按步拆进 countries/ 下（一步一个文件，见 countries/base.ts 的开头），这里照旧导出原来的这些，
// 别处的 import 不用改。邦联、联邦、同盟、附庸是国家格局（countries/patterns.ts）

export { COUNTRY_KM2, type CountryPlan, DEFAULT_YEARS, MAX_COUNTRIES, NOBODY, clearCountries, countryList, ensureCountryArray, sizeFactor } from './countries/base';
export { averageCountryKm2, estimateCountryCount, landComponents, plannedCountries } from './countries/count';
export { SUBJECT_NAMES, countryColor, subjectText, countryName, cultureContext, foundedYear, historyText, hslToHex, nameCountry, rulerTitleOf, titleContext, yearText } from './countries/records';
export { countriesStage, countryMixStage, countryPopScale } from './countries/stage';
export { blocsStage } from './countries/relate';
