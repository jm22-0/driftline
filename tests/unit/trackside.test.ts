import { InstancedMesh, Matrix4, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { type PitLane, createPitLane, pitRowIndex } from '../../src/game/pitLane';
import { generateTrack } from '../../src/game/trackLayout';
import { TRACK } from '../../src/game/tuning';
import { placeBrakeBoards } from '../../src/gfx/brakeBoards';
import { cornerOutsideSide, cornerRowMask, rowCurvature } from '../../src/gfx/corners';
import { createPalette } from '../../src/gfx/palette';
import { STAND_ROWS_AFTER, STAND_ROWS_BEFORE } from '../../src/gfx/startFacilities';
import { createTrackMesh } from '../../src/gfx/trackMesh';
import {
  HOARDING_PANELS,
  HOARDING_PANEL_PIXELS,
  HOARDING_TEX_HEIGHT,
  createTrackside,
  hoardingPixels,
  planTrackside,
} from '../../src/gfx/trackside';

const SEEDS = [42, 7, 135, 1, 2, 3];

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

/**
 * 一个点离「车能到的地方」还有多远(米,负数 = 伸进去了)。
 *
 * 故意不用 `trackside.ts` 自己的判断:对每个采样点算横向距离,维修道那几行
 * 的右侧按维修道外缘算。只看沿切线方向 4 米以内的采样(一行约 6 米)。
 */
function clearance(course: Course, lane: PitLane | null, x: number, z: number): number {
  let best = Infinity;
  course.layout.samples.forEach((sample, row) => {
    const dx = x - sample.x;
    const dz = z - sample.z;
    if (Math.abs(dx * sample.tangentX + dz * sample.tangentZ) > 4) {
      return;
    }
    const lateral = dx * -sample.tangentZ + dz * sample.tangentX;
    const edge =
      lateral > 0 && lane !== null && pitRowIndex(lane, row) >= 0
        ? lane.lateralMax
        : course.outerHalfWidth;
    best = Math.min(best, Math.abs(lateral) - edge);
  });
  return best;
}

function worldPoints(root: ReturnType<typeof createTrackside>): { name: string; x: number; z: number }[] {
  const points: { name: string; x: number; z: number }[] = [];
  const matrix = new Matrix4();
  const v = new Vector3();
  root.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }
    const position = child.geometry.getAttribute('position');
    const instances = child instanceof InstancedMesh ? child.count : 1;
    for (let n = 0; n < instances; n++) {
      if (child instanceof InstancedMesh) {
        child.getMatrixAt(n, matrix);
      } else {
        matrix.identity();
      }
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(matrix);
        points.push({ name: child.name, x: v.x, z: v.z });
      }
    }
  });
  return points;
}

describe('沿途设施摆在哪', () => {
  it('弯道外侧的符号和曲率相反,而且只在弯里有值', () => {
    for (const seed of SEEDS) {
      const { course } = build(seed);
      const mask = cornerRowMask(course);
      const outside = cornerOutsideSide(course);
      let sharp = 0;
      for (let row = 0; row < mask.length; row++) {
        expect(outside[row] !== 0).toBe(mask[row] === 1);
        const k = rowCurvature(course, row);
        if (Math.abs(k) >= 0.005) {
          sharp++;
          // 曲率为正 = 朝横向正方向拐,外侧在负的那一边。
          expect(outside[row]).toBe(k > 0 ? -1 : 1);
        }
      }
      expect(sharp).toBeGreaterThan(0);
    }
  });

  it('广告牌只立在弯道外侧;看台在广告牌那一段里面', () => {
    let hoardings = 0;
    let stands = 0;
    for (const seed of SEEDS) {
      const { course, lane } = build(seed);
      const count = course.layout.samples.length;
      const outside = cornerOutsideSide(course);
      const plan = planTrackside(course, lane);
      hoardings += plan.hoardings.length;
      stands += plan.stands.length;
      for (const run of plan.hoardings) {
        expect(run.to).toBeGreaterThan(run.from);
        for (let row = run.from; row <= run.to; row++) {
          expect(outside[row % count], `seed ${seed} row ${row}`).toBe(run.side);
        }
      }
      for (const stand of plan.stands) {
        const host = plan.hoardings.find(
          (run) => run.side === stand.side && run.from <= stand.from && run.to >= stand.to,
        );
        expect(host, `seed ${seed}`).toBeDefined();
      }
    }
    // 六条赛道加起来总得有东西:全被「放不下」的判断拦掉的话这个功能等于没有。
    expect(hoardings).toBeGreaterThan(6);
    expect(stands).toBeGreaterThan(2);
  });

  it('灯柱不立在主看台和弯道看台前面,岗亭不和刹车牌抢同一个位置', () => {
    for (const seed of SEEDS) {
      const { course, lane } = build(seed);
      const count = course.layout.samples.length;
      const plan = planTrackside(course, lane);
      expect(plan.lamps.length, `seed ${seed}`).toBeGreaterThan(count / 16);
      for (const row of plan.lamps) {
        expect(row > STAND_ROWS_AFTER && count - row > STAND_ROWS_BEFORE).toBe(true);
        for (const stand of plan.stands) {
          if (stand.side === -1) {
            const offset = (((row - stand.from) % count) + count) % count;
            expect(offset > stand.to - stand.from).toBe(true);
          }
        }
      }
      const boards = placeBrakeBoards(course, lane);
      for (const marshal of plan.marshals) {
        expect(
          boards.some((board) => board.row === marshal.row && board.side === marshal.side),
        ).toBe(false);
      }
      expect(plan.marshals.length).toBeGreaterThan(0);
    }
  });
});

describe('沿途设施都在护墙外面', () => {
  /*
   * 这些东西没有碰撞。只要有一个顶点伸进了路肩或者维修道,车就能从里面穿过去。
   * 灯臂是例外里的例外:它悬在 9 米高,但伸出去的那一头也停在条带外缘之外。
   */
  it('每一个顶点离车能到的地方都至少隔着一堵护墙的厚度', () => {
    for (const seed of SEEDS) {
      const { course, lane, palette } = build(seed);
      const points = worldPoints(createTrackside(course, palette, lane));
      expect(points.length).toBeGreaterThan(100);
      let worst = Infinity;
      let worstName = '';
      for (const point of points) {
        const c = clearance(course, lane, point.x, point.z);
        if (c < worst) {
          worst = c;
          worstName = point.name;
        }
      }
      expect(worst, `seed ${seed} ${worstName}`).toBeGreaterThan(0.55);
    }
  });

  it('没有维修道的场地照常能建', () => {
    const rng = new Rng(42);
    const course = new Course(generateTrack(rng.fork()), rng.fork());
    const group = createTrackside(course, createPalette(rng.fork()), null);
    expect(group.getObjectByName('lamp-posts')).toBeInstanceOf(InstancedMesh);
    expect(group.getObjectByName('hoarding-faces')).toBeInstanceOf(Mesh);
  });

  it('不消耗随机数:挂进赛道网格前后,传进去的 rng 走到同一个位置', () => {
    const { course, lane, palette } = build(42);
    const a = new Rng(43);
    createTrackMesh(course, a, palette, lane);
    const b = new Rng(43);
    createTrackMesh(course, b, palette, lane);
    expect(a.next()).toBe(b.next());
    const group = createTrackMesh(course, new Rng(43), palette, lane);
    expect(group.getObjectByName('trackside')).toBeDefined();
  });
});

describe('广告牌贴图', () => {
  it('从赛道上看过去,贴图的 u 总是朝观看者的右手走 —— 两侧的字都不是镜像的', () => {
    /*
     * 左侧的牌子拍图确认过字是正的;右侧的牌子要把 u 反过来才一样。
     * seed 42 和 7 的弯全是右手弯(牌子全在左侧),拍图看不到右侧,所以用几何钉住。
     */
    const sides = new Set<number>();
    for (const seed of SEEDS) {
      const { course, lane, palette } = build(seed);
      const faces = createTrackside(course, palette, lane).getObjectByName('hoarding-faces');
      expect(faces).toBeInstanceOf(Mesh);
      const geometry = (faces as Mesh).geometry;
      const position = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      expect(geometry.index).toBeNull();
      // `sweep()` 每个四边形出六个顶点,第 0 和第 2 个同高、u 不同。
      for (let i = 0; i < position.count; i += 6) {
        const ax = position.getX(i);
        const az = position.getZ(i);
        let nearest = course.layout.samples[0];
        let best = Infinity;
        for (const sample of course.layout.samples) {
          const d = Math.hypot(ax - sample.x, az - sample.z);
          if (d < best) {
            best = d;
            nearest = sample;
          }
        }
        if (nearest === undefined) {
          continue;
        }
        // 观看者站在中心线上朝牌子看:前方 f,右手 = f × up = (-f.z, f.x)。
        const fx = ax - nearest.x;
        const fz = az - nearest.z;
        sides.add(Math.sign(fx * -nearest.tangentZ + fz * nearest.tangentX));
        const along =
          (position.getX(i + 2) - ax) * -fz + (position.getZ(i + 2) - az) * fx;
        const du = uv.getX(i + 2) - uv.getX(i);
        expect(Math.sign(along), `seed ${seed} vertex ${i}`).toBe(Math.sign(du));
      }
    }
    expect([...sides].sort()).toEqual([-1, 1]);
  });

  it('每块牌面上都真的有字,而且字没有写倒', () => {
    const pixels = hoardingPixels();
    const width = HOARDING_PANEL_PIXELS * HOARDING_PANELS.length;
    expect(pixels.length).toBe(width * HOARDING_TEX_HEIGHT * 4);
    HOARDING_PANELS.forEach((panel, index) => {
      const isInk = (x: number, y: number): boolean => {
        const o = (y * width + index * HOARDING_PANEL_PIXELS + x) * 4;
        return pixels[o] === panel.ink[0] && pixels[o + 1] === panel.ink[1];
      };
      let ink = 0;
      let firstInkColumn = -1;
      for (let x = 0; x < HOARDING_PANEL_PIXELS; x++) {
        for (let y = 0; y < HOARDING_TEX_HEIGHT; y++) {
          if (isInk(x, y)) {
            ink++;
            if (firstInkColumn < 0) {
              firstInkColumn = x;
            }
          }
        }
      }
      const share = ink / (HOARDING_PANEL_PIXELS * HOARDING_TEX_HEIGHT);
      expect(share, panel.text).toBeGreaterThan(0.03);
      expect(share, panel.text).toBeLessThan(0.3);
      // 这几个词的首字母(D / A / G)左边一列:D 是整根竖线,A 和 G 顶上缺角。
      // 贴图第 0 行在底部,所以「顶上」是 y 大的那一头。
      const column = (y: number): boolean => isInk(firstInkColumn, y);
      const lit: number[] = [];
      for (let y = 0; y < HOARDING_TEX_HEIGHT; y++) {
        if (column(y)) {
          lit.push(y);
        }
      }
      const letter = panel.text[0];
      if (letter === 'D') {
        expect(lit.length).toBe(21);
      } else {
        // A、G 的左竖线不到顶:字形占 y = 6..26,最上面一个点阵格(24..26)是空的。
        // 写倒了的话空的会是最下面那一格。G 底下也缺一格,A 不缺。
        expect(Math.max(...lit)).toBe(23);
        expect(Math.min(...lit)).toBe(letter === 'G' ? 9 : 6);
      }
    });
  });
});
