import { z } from 'zod';

// 生态、河流类型等的 id：两处用同一条规则（资源包里的各种类型互相引用时不会有的能用、有的不能用）。
// 单独一个只引用 zod 的文件：species.ts 经 script.ts 引用 world.ts，world.ts 的河道在模块顶层就要用它，
// 放在 species.ts 里会碰上“初始化之前不能访问”（见 import-order.test.ts）。species.ts 照旧导出它
export const typeIdSchema = z.string().regex(/^[\w-]+$/, 'id 只能包含字母、数字、下划线和连字符');
