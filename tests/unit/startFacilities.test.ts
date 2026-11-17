import { Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { Course } from '../../src/game/course';
import { type PitLane, createPitLane } from '../../src/game/pitLane';
import { generateTrack } from '../../src/game/trackLayout';
import { RACE_FORMAT, TRACK } from '../../src/game/tuning';
import { createPalette } from '../../src/gfx/palette';
import {
  GARAGE_SETBACK,
  START_LAMP_COUNT,
  STAND_SETBACK,
  createStartFacilities,
  crowdPixels,
  findStartLamps,
  garagePixels,
  setStartLamps,
  startLampsLit,
} from '../../src/gfx/startFacilities';
import { createTrackMesh } from '../../src/gfx/trackMesh';

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

/** 一个世界坐标点相对中心线的有符号横向距离(`Course` 的符号:维修道那一侧为正)。 */
function lateralOf(course: Course, x: number, z: number): number {
  let best = 0;
  let bestAlong = Infinity;
  for (const sample of course.layout.samples) {
    const dx = x - sample.x;
    const dz = z - sample.z;
    if (Math.hypot(dx, dz) > 80) {
      continue;
    }
    const along = Math.abs(dx * sample.tangentX + dz * sample.tangentZ);
    if (along < bestAlong) {
      bestAlong = along;
      best = dx * -sample.tangentZ + dz * sample.tangentX;
    }
  }
  return best;
}

function lateralRange(course: Course, mesh: Mesh): { min: number; max: number } {
  const position = mesh.geometry.getAttribute('position');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const d = lateralOf(course, position.getX(i), position.getZ(i));
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return { min, max };
}

describe('起跑灯', () => {
  const total = RACE_FORMAT.countdownSeconds;

  it('倒计时里一盏一盏亮起来,走完之后全灭 —— 灭灯才是发车', () => {
    expect(startLampsLit(total, total)).toBe(1);
    expect(startLampsLit(0.01, total)).toBe(START_LAMP_COUNT);
    expect(startLampsLit(0, total)).toBe(0);
    let previous = 0;
    for (let remaining = total; remaining > 0; remaining -= 1 / 60) {
      const lit = startLampsLit(remaining, total);
      expect(lit).toBeGreaterThanOrEqual(previous);
      expect(lit).toBeLessThanOrEqual(START_LAMP_COUNT);
      previous = lit;
    }
    expect(previous).toBe(START_LAMP_COUNT);
  });

  it('龙门架上有五盏灯,点亮几盏就是几盏在发光', () => {
    const { course, lane, palette } = build(42);
    const group = createTrackMesh(course, new Rng(43), palette, lane);
    const lamps = findStartLamps(group);
    expect(lamps.length).toBe(START_LAMP_COUNT);
    for (const lamp of lamps) {
      expect(lamp).toBeInstanceOf(MeshStandardMaterial);
      expect(lamp.emissiveIntensity).toBe(0);
    }
    setStartLamps(lamps, 3);
    expect(lamps.filter((lamp) => lamp.emissiveIntensity > 1).length).toBe(3);
    setStartLamps(lamps, 0);
    expect(lamps.filter((lamp) => lamp.emissiveIntensity > 0).length).toBe(0);
    // 平地场没有赛道网格:拿到空数组,调用方不用判空。
    expect(findStartLamps(null)).toEqual([]);
  });
});

describe('起跑直道的设施都在护墙外面', () => {
  /*
   * 这些东西没有碰撞。只要有一个顶点伸进了路肩或者维修道,车就能从里面穿过去。
   */
  it('看台整个在赛道左侧护墙之外,维修区建筑整个在维修道外缘之外', () => {
    for (const seed of [42, 7, 135]) {
      const { course, lane, palette } = build(seed);
      const group = createStartFacilities(course, palette, lane);
      for (const name of ['grandstand-crowd', 'grandstand-structure']) {
        const mesh = group.getObjectByName(name);
        expect(mesh, name).toBeInstanceOf(Mesh);
        const range = lateralRange(course, mesh as Mesh);
        // 顶棚往赛道方向挑出 1.5 米,仍然在护墙(厚 0.55 米)之外。
        expect(range.max, `${name} seed ${seed}`).toBeLessThan(-(course.outerHalfWidth + 0.6));
        expect(range.min).toBeLessThan(-(course.outerHalfWidth + STAND_SETBACK));
      }
      const garages = group.getObjectByName('pit-garages');
      expect(garages).toBeInstanceOf(Mesh);
      const range = lateralRange(course, garages as Mesh);
      expect(range.min, `seed ${seed}`).toBeGreaterThan(lane.lateralMax + GARAGE_SETBACK - 0.5);
    }
  });

  it('没有维修道的场地不盖维修区建筑,别的照常', () => {
    const rng = new Rng(42);
    const course = new Course(generateTrack(rng.fork()), rng.fork());
    const group = createStartFacilities(course, createPalette(rng.fork()), null);
    expect(group.getObjectByName('pit-garages')).toBeUndefined();
    expect(group.getObjectByName('grandstand-crowd')).toBeInstanceOf(Mesh);
    expect(group.getObjectByName('start-gantry')).toBeDefined();
  });
});

describe('程序化贴图', () => {
  it('看台大约八成上座:有人的像素和空座的像素都占相当一部分', () => {
    const pixels = crowdPixels();
    let people = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // 空座是固定的深蓝灰 (46, 50, 58)。
      people += pixels[i] === 46 && pixels[i + 1] === 50 && pixels[i + 2] === 58 ? 0 : 1;
    }
    const share = people / (pixels.length / 4);
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.7);
  });

  it('车库立面最左一列是纯墙色(屋顶和背面的 UV 指在那儿),中间是深色的门', () => {
    const pixels = garagePixels();
    const at = (x: number, y: number): number => pixels[(y * 96 + x) * 4] ?? 0;
    for (let y = 0; y < 64; y++) {
      expect(at(1, y)).toBe(168);
    }
    expect(at(48, 10)).toBeLessThan(60);
  });
});
