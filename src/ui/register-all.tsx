// 登记（第六十九轮；和 App.tsx 一样是组成界面的根，所以是 .tsx）：工具表（defs/tools/）里按名字引用的部件、每个工具做什么，各自在自己的模块里登记，
// 这里把它们都引用一次（App.tsx 引用它；测试要用到底部条、工具对象时也引用它）。
// 声明的一方（defs/）不引用实现的一方（panels/、tools/），所以不绕成圈
import './panels/islandTypes';
import './panels/human';
import './panels/nature-bar';
import './panels/rivers';
import './panels/riverTypes';
import './panels/lakes';
import './provincePanel';
import './panels/names';
import './panels/culture';
import './panels/countries';
import './panels/settlements';
import './tools/bind';
