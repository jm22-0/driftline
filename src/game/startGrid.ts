import { clamp } from '../core/mathx';
import { RACE_FORMAT } from './tuning';

/** 发车格离路面边缘至少留这么多(米),车身不压线。 */
export const GRID_EDGE_MARGIN = 1.5;

/**
 * 发车格:第 `slot` 位(0 = 玩家的杆位)相对起跑线的纵向后退距离与横向偏移。
 *
 * 两两一排交错(和真实发车格一样),不是一字纵队——纵队里后车全程被前车
 * 挡着,永远看不到超车。
 */
export function gridSlot(slot: number): { back: number; lateral: number } {
  // 杆位(玩家)留在中心线上。真实发车格杆位也是偏一侧的,但把玩家摆偏之后
  // 一上来就得先并回赛道中间,而且「起跑在中心线」是既有截图测试钉住的行为
  // (smoke.spec.ts「起跑时在赛道上」断言 |lateral| < 1)。对手才交错排开。
  if (slot <= 0) {
    return { back: 0, lateral: 0 };
  }
  const index = slot - 1;
  const row = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  return {
    back: (row + 1) * RACE_FORMAT.gridRow,
    lateral: side * RACE_FORMAT.gridLateral,
  };
}

/**
 * 第 `slot` 位的车**实际**停在哪:相对起跑线的弧长后退量(米)与横向偏移(米,
 * 赛道右手法向为正)。
 *
 * 和 `gridSlot()` 的区别是这里做了 `World` 摆车时的那两步取整:纵向吸附到最近的
 * 赛道采样点,横向压在路面以内。**画在地上的发车格必须用这个**,否则格子和车
 * 差出半个采样间距(3 米)。
 */
export function gridPlacement(
  slot: number,
  spacing: number,
  halfWidth: number,
): { back: number; lateral: number } {
  const { back, lateral } = gridSlot(slot);
  const room = halfWidth - GRID_EDGE_MARGIN;
  return {
    back: Math.round(back / spacing) * spacing,
    lateral: clamp(lateral, -room, room),
  };
}
