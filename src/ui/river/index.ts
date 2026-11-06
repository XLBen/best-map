// 画河、选河、改河、删河：river/ 下分开（model 走向与命令、query 认河与河的说明、shapes 画法、bar 底部条上的预览、tool 两个工具），
// 这里一起导出（第七十轮以前是 ui/riverCourse.ts），外面从 './river' 引用
export { applyPatch } from '../../../core/river-edit';
export * from './model';
export * from './query';
export * from './shapes';
export * from './bar';
export * from './tool';
