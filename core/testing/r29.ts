import saved from '../human/r29-digests.json';

// r29-digests.json（核对“同一个库、同样的选择，生成的结果不变”）。第五十五轮重录（生态跟高度走），第五十一轮单独记着的奇幻的 resource 也进了文件
export function r29Digest(key: string): Record<string, string> {
  return (saved as Record<string, Record<string, string>>)[key];
}
