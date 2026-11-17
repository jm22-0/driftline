import { InstancedMesh, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { type PitLane, createPitLane, pitRowIndex } from '../../src/game/pitLane';
import { gridPlacement } from '../../src/game/startGrid';
import { generateTrack } from '../../src/game/trackLayout';
import { RACE_FORMAT, TRACK } from '../../src/game/tuning';
import {
  BRAKE_BOARD_DISTANCES,
  brakeBoardPixels,
  placeBrakeBoards,
} from '../../src/gfx/brakeBoards';
import { cornerRowMask, rowCurvature } from '../../src/gfx/corners';
import { createPalette } from '../../src/gfx/palette';
import {
  createTrackMesh,
  pitMarkingUniforms,
  roadMarkingUniforms,
} from '../../src/gfx/trackMesh';

const SEEDS = [42, 7, 135, 1337];

function build(seed: number): {
  course: Course;
  lane: PitLane;
  palette: ReturnType<typeof createPalette>;
} {
  const rng = new Rng(seed);
  const layout = generateTrack(rng.fork());
  const lane = createPitLane(layout, layout.halfWidth + TRACK.shoulderWidth);
  const course = new Course(layout, rng.fork(), lane);
  return { course, lane, palette: createPalette(rng.fork()) };
}

describe('发车格', () => {
  /*
   * 格子画在着色器里,用的是条带 UV 的坐标;车是 `World` 按赛道右手法向摆的。
   * 两套坐标的横向符号相反 —— 符号搞反了截图上照样是「地上有四个白框」,只是
   * 左右两列的框和车对调了,不盯着看发现不了。所以把两边都换算成世界坐标来比。
   */
  it('每个格子的前横线在它那辆车的车头前面,左右没有对调', () => {
    for (const seed of SEEDS) {
      const { course, palette } = build(seed);
      const u = roadMarkingUniforms(course, palette);
      const { samples, spacing } = course.layout;
      expect(u.gridSlots.length).toBe(RACE_FORMAT.rivalCount + 1);
      u.gridSlots.forEach(([arc, uvLateral], slot) => {
        const { back, lateral } = gridPlacement(slot, spacing, course.halfWidth);
        const row = (((-Math.round(back / spacing)) % samples.length) + samples.length) % samples.length;
        const sample = samples[row];
        if (sample === undefined) {
          throw new Error('没有这一行');
        }
        // `World.placeAt()` 的摆法:赛道右手法向 = (tangentZ, -tangentX)。
        const carX = sample.x + sample.tangentZ * lateral;
        const carZ = sample.z - sample.tangentX * lateral;
        // 条带的摆法(`Course`):right = (-tangentZ, tangentX)。
        const boxX = sample.x - sample.tangentZ * uvLateral;
        const boxZ = sample.z + sample.tangentX * uvLateral;
        expect(Math.hypot(carX - boxX, carZ - boxZ)).toBeLessThan(1e-9);

        // 前横线在车辆中心前方 2~3 米(车长 4.2 米):顶着车头,不压在车底下。
        const ahead = (((arc + back) % u.trackLength) + u.trackLength) % u.trackLength;
        expect(ahead).toBeGreaterThan(2.1);
        expect(ahead).toBeLessThan(3);
        // 着色器只在起跑线附近这一段找格子:每个框都得落在这一段里。
        const signed = arc > u.trackLength / 2 ? arc - u.trackLength : arc;
        expect(Math.abs(signed) + u.gridSideLength).toBeLessThan(u.gridReach);
        // 整个框在路面以内。
        expect(Math.abs(uvLateral) + u.gridHalfWidth).toBeLessThan(course.halfWidth);
      });
    }
  });

  it('框比车宽、比一个车位间距窄,相邻的框不叠在一起', () => {
    const { course, palette } = build(42);
    const u = roadMarkingUniforms(course, palette);
    expect(u.gridHalfWidth * 2).toBeGreaterThan(1.8);
    expect(u.gridHalfWidth * 2).toBeLessThan(RACE_FORMAT.gridLateral * 2);
    expect(u.gridLineWidth).toBeLessThan(0.3);
  });
});

describe('路肩红白条', () => {
  it('只铺在弯里:曲率过门槛的行都有,前后两行内都是直道的行没有', () => {
    for (const seed of SEEDS) {
      const { course } = build(seed);
      const mask = cornerRowMask(course);
      const count = mask.length;
      let on = 0;
      for (let row = 0; row < count; row++) {
        const here = Math.abs(rowCurvature(course, row));
        const before = Math.abs(rowCurvature(course, (row - 1 + count) % count));
        const after = Math.abs(rowCurvature(course, (row + 1) % count));
        if (here >= 0.005) {
          expect(mask[row]).toBe(1);
        }
        if (Math.max(here, before, after) < 0.005) {
          expect(mask[row]).toBe(0);
        }
        on += mask[row] ?? 0;
      }
      // 一圈里有弯也有直道:全铺或者一处没有都说明门槛不对。
      expect(on / count, `seed ${seed}`).toBeGreaterThan(0.04);
      expect(on / count, `seed ${seed}`).toBeLessThan(0.4);
    }
  });

  it('每个顶点带的是它自己那一行的值', () => {
    const { course, lane, palette } = build(42);
    const group = createTrackMesh(course, new Rng(43), palette, lane);
    const ribbon = group.getObjectByName('track-ribbon');
    if (!(ribbon instanceof Mesh)) {
      throw new Error('赛道网格里没有 track-ribbon');
    }
    const kerb = ribbon.geometry.getAttribute('kerb');
    const uv = ribbon.geometry.getAttribute('uv');
    const mask = cornerRowMask(course);
    expect(kerb.count).toBe(uv.count);
    let ones = 0;
    for (let i = 0; i < kerb.count; i++) {
      const row = Math.round((uv.getY(i) * TRACK.textureScale) / course.layout.spacing) % mask.length;
      expect(kerb.getX(i)).toBe(mask[row]);
      ones += kerb.getX(i);
    }
    expect(ones).toBeGreaterThan(0);
  });

  it('红条是红的,白条用的是边线那个白', () => {
    const { course, palette } = build(42);
    const u = roadMarkingUniforms(course, palette);
    const [r, g, b] = u.kerbRedAlbedo;
    expect(r).toBeGreaterThan(g * 3);
    expect(r).toBeGreaterThan(b * 3);
    expect(u.kerbWidth).toBeGreaterThan(0.6);
    expect(u.kerbWidth).toBeLessThan(1.6);
  });
});

describe('刹车距离牌', () => {
  it('牌子到弯之间全是直道,距离对得上,立在弯的外侧且不占维修道那一边', () => {
    let total = 0;
    for (const seed of SEEDS) {
      const { course, lane } = build(seed);
      const mask = cornerRowMask(course);
      const count = mask.length;
      const spacing = course.layout.spacing;
      const boards = placeBrakeBoards(course, lane);
      total += boards.length;
      for (const board of boards) {
        expect(BRAKE_BOARD_DISTANCES).toContain(board.distance);
        const gap = (((board.cornerRow - board.row) % count) + count) % count;
        expect(Math.abs(gap * spacing - board.distance)).toBeLessThanOrEqual(spacing / 2);
        expect(mask[board.cornerRow]).toBe(1);
        for (let i = 0; i < gap; i++) {
          expect(mask[(board.row + i) % count]).toBe(0);
        }
        if (pitRowIndex(lane, board.row) >= 0) {
          expect(board.side).toBe(-1);
        } else {
          // 外侧 = 和拐弯方向相反的那一边。取弯里曲率最大的那一行判方向。
          let turn = 0;
          for (let r = board.cornerRow; (mask[r % count] ?? 0) !== 0 && r < board.cornerRow + count; r++) {
            const k = rowCurvature(course, r % count);
            if (Math.abs(k) > Math.abs(turn)) {
              turn = k;
            }
          }
          expect(board.side).toBe(turn > 0 ? -1 : 1);
        }
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it('网格里的实例数和牌子数一致,而且都立在护墙外面', () => {
    const { course, lane, palette } = build(42);
    const boards = placeBrakeBoards(course, lane);
    const group = createTrackMesh(course, new Rng(43), palette, lane);
    const posts = group.getObjectByName('brake-board-posts');
    expect(posts).toBeInstanceOf(InstancedMesh);
    expect((posts as InstancedMesh).count).toBe(boards.length);
    let panels = 0;
    for (const distance of BRAKE_BOARD_DISTANCES) {
      const mesh = group.getObjectByName(`brake-board-${distance}`);
      panels += mesh instanceof InstancedMesh ? mesh.count : 0;
    }
    expect(panels).toBe(boards.length);
  });

  it('牌面上真的有字,而且三块牌子的字不一样', () => {
    const dark = (text: string): number => {
      const pixels = brakeBoardPixels(text);
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        n += (pixels[i] ?? 255) < 80 ? 1 : 0;
      }
      return n / (pixels.length / 4);
    };
    for (const text of ['200', '100', '50']) {
      expect(dark(text), text).toBeGreaterThan(0.05);
      expect(dark(text), text).toBeLessThan(0.5);
    }
    expect(brakeBoardPixels('200')).not.toEqual(brakeBoardPixels('100'));
    // 「1」的点阵上窄下宽(底下有一横):贴图第 0 行在底部,写反了这条会红。
    const one = brakeBoardPixels('1');
    const darkInRows = (from: number, to: number): number => {
      let n = 0;
      for (let y = from; y < to; y++) {
        for (let x = 0; x < 80; x++) {
          n += (one[(y * 80 + x) * 4] ?? 255) < 80 ? 1 : 0;
        }
      }
      return n;
    };
    expect(darkInRows(10, 14)).toBeGreaterThan(darkInRows(34, 38));
  });
});

describe('维修道标线', () => {
  /*
   * 维修道路面的弧长坐标不回绕:这条道跨过终点线,出口的行号比入口小,
   * 直接拿行号乘行距的话「出口那道线」会落在入口前面几千米,整条画不出来。
   */
  it('限速线和车位线都落在维修道自己的弧长范围里,顺序是 入口 → 限速 → 车位 → 车位 → 限速 → 出口', () => {
    for (const seed of SEEDS) {
      const { lane, palette } = build(seed);
      const u = pitMarkingUniforms(lane, palette);
      const entryArc = lane.entryRow * lane.spacing;
      const exitArc = entryArc + (lane.laneRowCount - 1) * lane.spacing;
      expect(u.wallStartArc).toBeGreaterThan(entryArc);
      expect(u.boxStartArc).toBeGreaterThan(u.wallStartArc);
      expect(u.boxEndArc).toBeGreaterThan(u.boxStartArc);
      expect(u.wallEndArc).toBeGreaterThan(u.boxEndArc);
      expect(exitArc).toBeGreaterThan(u.wallEndArc);
      // 分界线在维修道里面,不贴边。
      expect(u.laneDivider).toBeGreaterThan(1);
      expect(u.laneDivider).toBeLessThan(lane.lateralMax - lane.lateralMin - 1);
    }
  });
});
