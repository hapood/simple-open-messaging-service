import { Component, output } from '@angular/core';
import { IconComponent, AppIconType } from '../icon/icon.component';

/**
 * 顶部栏：汉堡按钮（toggleDrawer output）+ SOMS 标题 + 搜索按钮。
 * 菜单逻辑（好友请求/新建群组/文件夹/登出）已迁至 <app-nav-drawer>；
 * 本组件只负责触发抽屉开关，不再持有任何菜单状态。
 */
@Component({
  selector: 'app-home-header',
  imports: [IconComponent],
  templateUrl: './home-header.component.html',
  styleUrl: './home-header.component.scss',
})
export class HomeHeaderComponent {
  readonly AppIconType = AppIconType
  readonly toggleDrawer = output<void>()
}
