import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Course } from '../game/course';
import { type PitLane, pitRowIndex } from '../game/pitLane';
import { cornerOutsideSide } from './corners';
import type { Palette } from './palette';
import {
  type ProfilePoint,
  SKIRT,
  STAND_ROWS_AFTER,
  STAND_ROWS_BEFORE,
  crowdPixels,
  sweep,
  tiledTexture,
} from './startFacilities';

/**
 * 沿途设施:弯道外侧的广告牌和小看台、灯柱、裁判岗亭。
 *
 * 和起跑直道那几样(`startFacilities.ts`)同一套规矩:全部立在护墙**外面**,
 * 所以不做碰撞;全部**不消耗随机数**。
 *
 * 轮胎墙没做:真的轮胎墙摆在护墙**里面**(车先撞到它),那就得有碰撞,
 * 是物理改动,不是摆设。
 */

/** 广告牌离条带外缘多远(米)。护墙厚 0.55,留一条缝。 */
export const HOARDING_OFFSET = 1;
/** 牌面下沿、上沿离地(米)。护墙高 1.08:下沿正好藏在墙顶后面。 */
const HOARDING_BOTTOM = 1;
const HOARDING_TOP = 2.3;
const HOARDING_THICKNESS = 0.1;
/** 一块牌面占几行(一行约 6 米)。 */
const HOARDING_PANEL_ROWS = 2;

/** 弯道看台前沿离条带外缘多远(米):在广告牌和灯柱后面。 */
export const CORNER_STAND_SETBACK = 4.5;
const CORNER_STAND_TIERS = 6;
const TIER_RUN = 0.85;
const TIER_RISE = 0.5;
/** 第一排离地(米)。要高过广告牌上沿,不然第一排看的是牌子的背面。 */
const CORNER_STAND_FRONT_HEIGHT = 2.5;
const CORNER_STAND_RAIL = 1;
/** 弯至少这么多行才配一座看台;看台最长这么多行。 */
const CORNER_STAND_MIN_RINGS = 5;
const CORNER_STAND_MAX_RINGS = 9;
const CORNER_STAND_DEPTH = CORNER_STAND_TIERS * TIER_RUN;

/** 灯柱每隔几行一根(约 48 米),立在赛道左侧(维修道对面)。 */
const LAMP_EVERY_ROWS = 8;
/** 灯柱离条带外缘多远(米):在刹车牌(1.3)和岗亭后面,不和它们穿插。 */
export const LAMP_OFFSET = 3.2;
const LAMP_HEIGHT = 9;
const LAMP_ARM = 2.6;

/** 裁判岗亭中心离条带外缘多远(米)。 */
export const MARSHAL_OFFSET = 2;
const MARSHAL_SIZE = 1.6;
/** 岗亭地板离地(米):裁判要能越过护墙看到路面。 */
const MARSHAL_FLOOR = 1.2;

/** 隔了这么多行以上的另一段赛道算「别的路段」,离它的条带外缘至少要这么远(米)。 */
const FAR_ROWS = 20;
/** 24 米:盖得住那一段可能有的维修道(12)加车库(1.6 + 8),或者主看台(3 + 8.9)。 */
const FAR_CLEARANCE = 24;

/** 一段连续的行。`from`/`to` 都含,**不回绕**(`to` 可以超过总行数)。 */
export interface SideRun {
  from: number;
  to: number;
  /** `Course` 的横向符号。 */
  side: -1 | 1;
}

export interface TracksidePlan {
  hoardings: SideRun[];
  stands: SideRun[];
  /** 灯柱所在的行,都在横向负的那一侧。 */
  lamps: number[];
  marshals: { row: number; side: -1 | 1 }[];
}

function wrap(row: number, count: number): number {
  return ((row % count) + count) % count;
}

/**
 * 第 `row` 行、`side` 那一侧、离条带外缘 `reach` 米以内,能不能放东西。
 *
 * 三种不能放:那一侧是维修道;那一侧是主看台;或者赛道绕回来的另一段
 * 正好从这儿经过 —— 赛道是生成的,没人保证两段路之间隔得开。
 */
function siteClear(
  course: Course,
  pit: PitLane | null,
  row: number,
  side: -1 | 1,
  reach: number,
): boolean {
  const samples = course.layout.samples;
  const count = samples.length;
  const r = wrap(row, count);
  if (side === 1 && pit !== null) {
    for (let o = -2; o <= 2; o++) {
      if (pitRowIndex(pit, wrap(r + o, count)) >= 0) {
        return false;
      }
    }
  }
  if (side === -1 && (r <= STAND_ROWS_AFTER + 2 || count - r <= STAND_ROWS_BEFORE + 2)) {
    return false;
  }
  const own = samples[r];
  if (own === undefined) {
    return false;
  }
  const d = course.outerHalfWidth + reach;
  const x = own.x - own.tangentZ * side * d;
  const z = own.z + own.tangentX * side * d;
  for (let j = 0; j < count; j++) {
    const other = samples[j];
    if (other === undefined) {
      continue;
    }
    const distance = Math.hypot(x - other.x, z - other.z);
    // 比到自己这一行还近:说明这个点其实落在另一段路的地盘里。
    if (distance < d - 0.5) {
      return false;
    }
    const apart = Math.min(Math.abs(j - r), count - Math.abs(j - r));
    if (apart > FAR_ROWS && distance < course.outerHalfWidth + FAR_CLEARANCE) {
      return false;
    }
  }
  return true;
}

/** 把「每行一个符号」切成连续同号的段。至少两行才成段(一行扫不出面)。 */
function extractRuns(sides: Int8Array): SideRun[] {
  const count = sides.length;
  let start = -1;
  for (let row = 0; row < count; row++) {
    if ((sides[row] ?? 0) !== (sides[(row - 1 + count) % count] ?? 0)) {
      start = row;
      break;
    }
  }
  const runs: SideRun[] = [];
  if (start < 0) {
    return runs;
  }
  let from = start;
  for (let i = 1; i <= count; i++) {
    const current = sides[(start + i) % count] ?? 0;
    const previous = sides[(start + i - 1) % count] ?? 0;
    if (i === count || current !== previous) {
      if (previous !== 0 && start + i - 1 > from) {
        runs.push({ from, to: start + i - 1, side: previous > 0 ? 1 : -1 });
      }
      from = start + i;
    }
  }
  return runs;
}

/** 东西摆在哪。纯计算,导出给单测。 */
export function planTrackside(course: Course, pit: PitLane | null): TracksidePlan {
  const count = course.layout.samples.length;
  const outside = cornerOutsideSide(course);

  const hoardingSides = new Int8Array(count);
  for (let row = 0; row < count; row++) {
    const side = outside[row] ?? 0;
    if (side !== 0 && siteClear(course, pit, row, side > 0 ? 1 : -1, HOARDING_OFFSET + 0.5)) {
      hoardingSides[row] = side;
    }
  }
  const hoardings = extractRuns(hoardingSides);

  const stands: SideRun[] = [];
  for (const run of hoardings) {
    const rings = run.to - run.from + 1;
    if (rings < CORNER_STAND_MIN_RINGS) {
      continue;
    }
    const length = Math.min(rings, CORNER_STAND_MAX_RINGS);
    const from = run.from + Math.floor((rings - length) / 2);
    let clear = true;
    for (let row = from; row < from + length; row++) {
      if (!siteClear(course, pit, row, run.side, CORNER_STAND_SETBACK + CORNER_STAND_DEPTH + 1)) {
        clear = false;
        break;
      }
    }
    if (clear) {
      stands.push({ from, to: from + length - 1, side: run.side });
    }
  }

  const lamps: number[] = [];
  for (let row = 0; row + LAMP_EVERY_ROWS / 2 < count; row += LAMP_EVERY_ROWS) {
    // 看台前面不立灯柱:挡视线,而且柱子会从座位中间穿出来。
    const inFrontOfStand = stands.some(
      (stand) =>
        stand.side === -1 &&
        wrap(row - stand.from, count) <= stand.to - stand.from,
    );
    if (!inFrontOfStand && siteClear(course, pit, row, -1, LAMP_OFFSET + 0.5)) {
      lamps.push(row);
    }
  }

  // 每个弯的入口、弯的**内侧**一座岗亭:外侧是车冲出去的方向,裁判不站那儿。
  const marshals: { row: number; side: -1 | 1 }[] = [];
  for (let row = 0; row < count; row++) {
    const here = outside[row] ?? 0;
    const before = outside[(row - 1 + count) % count] ?? 0;
    if (here === 0 || before !== 0) {
      continue;
    }
    const side: -1 | 1 = here > 0 ? -1 : 1;
    const at = (row - 1 + count) % count;
    if (siteClear(course, pit, at, side, MARSHAL_OFFSET + MARSHAL_SIZE)) {
      marshals.push({ row: at, side });
    }
  }
  return { hoardings, stands, lamps, marshals };
}

/** 5×7 点阵字母,每行一个 5 位二进制数,高位在左。只有牌子上用得到的那几个。 */
const LETTERS: Readonly<Record<string, readonly number[]>> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
};

/**
 * 牌面上的字和配色。**都是编出来的名字** —— 不放任何真实品牌(商标不是我们的)。
 * 颜色压过饱和度:户外的喷绘晒过,而且纯色在 bloom 下会发光。
 */
export const HOARDING_PANELS: readonly {
  text: string;
  background: readonly [number, number, number];
  ink: readonly [number, number, number];
}[] = [
  { text: 'DRIFTLINE', background: [168, 30, 26], ink: [226, 224, 216] },
  { text: 'APEX', background: [206, 164, 34], ink: [22, 22, 24] },
  { text: 'DRIFTLINE', background: [24, 40, 88], ink: [226, 224, 216] },
  { text: 'GRIP', background: [208, 208, 200], ink: [22, 22, 24] },
];

export const HOARDING_PANEL_PIXELS = 256;
export const HOARDING_TEX_HEIGHT = 32;
const HOARDING_GLYPH_SCALE = 3;
/** 贴图最上和最下各两行是边框色;牌子的背面和埋进地里的部分 UV 也指在这儿。 */
const HOARDING_BORDER: readonly [number, number, number] = [44, 46, 50];
const HOARDING_BORDER_V = 1 / HOARDING_TEX_HEIGHT;

/** 广告牌贴图:几块牌面横着排开。**程序化画出来的点阵字**,不是字体文件。导出给单测。 */
export function hoardingPixels(): Uint8Array {
  const width = HOARDING_PANEL_PIXELS * HOARDING_PANELS.length;
  const data = new Uint8Array(width * HOARDING_TEX_HEIGHT * 4);
  const put = (x: number, y: number, colour: readonly [number, number, number]): void => {
    const o = (y * width + x) * 4;
    data[o] = colour[0];
    data[o + 1] = colour[1];
    data[o + 2] = colour[2];
    data[o + 3] = 255;
  };
  HOARDING_PANELS.forEach((panel, index) => {
    const x0 = index * HOARDING_PANEL_PIXELS;
    for (let y = 0; y < HOARDING_TEX_HEIGHT; y++) {
      for (let x = 0; x < HOARDING_PANEL_PIXELS; x++) {
        const frame =
          y < 2 || y >= HOARDING_TEX_HEIGHT - 2 || x < 2 || x >= HOARDING_PANEL_PIXELS - 2;
        put(x0 + x, y, frame ? HOARDING_BORDER : panel.background);
      }
    }
    const glyphWidth = 5 * HOARDING_GLYPH_SCALE;
    const gap = HOARDING_GLYPH_SCALE;
    const total = panel.text.length * glyphWidth + (panel.text.length - 1) * gap;
    const left = x0 + Math.floor((HOARDING_PANEL_PIXELS - total) / 2);
    const top = Math.floor((HOARDING_TEX_HEIGHT - 7 * HOARDING_GLYPH_SCALE) / 2);
    for (let c = 0; c < panel.text.length; c++) {
      const glyph = LETTERS[panel.text[c] ?? ''];
      if (glyph === undefined) {
        continue;
      }
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (((glyph[gy] ?? 0) >> (4 - gx)) % 2 === 0) {
            continue;
          }
          for (let y = 0; y < HOARDING_GLYPH_SCALE; y++) {
            for (let x = 0; x < HOARDING_GLYPH_SCALE; x++) {
              // DataTexture 的第 0 行在贴图底部,字要倒着写进去才是正的。
              put(
                left + c * (glyphWidth + gap) + gx * HOARDING_GLYPH_SCALE + x,
                HOARDING_TEX_HEIGHT - 1 - (top + gy * HOARDING_GLYPH_SCALE + y),
                panel.ink,
              );
            }
          }
        }
      }
    }
  });
  return data;
}

function rowRange(run: SideRun): number[] {
  const rows: number[] = [];
  for (let row = run.from; row <= run.to; row++) {
    rows.push(row);
  }
  return rows;
}

function merged(parts: BufferGeometry[]): BufferGeometry | null {
  return parts.length === 0 ? null : mergeGeometries(parts);
}

function createHoardings(course: Course, runs: readonly SideRun[]): Group {
  const group = new Group();
  group.name = 'hoardings';
  const faces: BufferGeometry[] = [];
  const backs: BufferGeometry[] = [];
  const face: ProfilePoint[] = [
    { out: 0, up: HOARDING_BOTTOM, v: 0 },
    { out: 0, up: HOARDING_TOP, v: 1 },
  ];
  const back: ProfilePoint[] = [
    { out: 0, up: HOARDING_BOTTOM, v: HOARDING_BORDER_V },
    { out: 0, up: -SKIRT, v: HOARDING_BORDER_V },
    { out: HOARDING_THICKNESS, up: -SKIRT, v: HOARDING_BORDER_V },
    { out: HOARDING_THICKNESS, up: HOARDING_TOP, v: HOARDING_BORDER_V },
    { out: 0, up: HOARDING_TOP, v: HOARDING_BORDER_V },
  ];
  const perMetre = 1 / (HOARDING_PANELS.length * HOARDING_PANEL_ROWS * course.layout.spacing);
  for (const run of runs) {
    const rows = rowRange(run);
    const baseOut = (): number => course.outerHalfWidth + HOARDING_OFFSET;
    // 从赛道上看,左侧的牌子 u 朝右走,右侧的朝左走:右侧要把 u 反过来,字才不是镜像的。
    faces.push(sweep(course, rows, run.side, baseOut, face, run.side === -1 ? perMetre : -perMetre));
    backs.push(sweep(course, rows, run.side, baseOut, back, 0, 0.001));
  }
  const material = new MeshStandardMaterial({
    map: tiledTexture(
      hoardingPixels(),
      HOARDING_PANEL_PIXELS * HOARDING_PANELS.length,
      HOARDING_TEX_HEIGHT,
    ),
    roughness: 0.6,
    side: DoubleSide,
  });
  for (const [name, parts] of [
    ['hoarding-faces', faces],
    ['hoarding-backs', backs],
  ] as const) {
    const geometry = merged(parts);
    if (geometry !== null) {
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

/** 看台两头的山墙:不封上的话,从弯前开过来正好看进台阶底下。 */
function standEndCap(course: Course, run: SideRun, row: number): BufferGeometry {
  const samples = course.layout.samples;
  const sample = samples[wrap(row, samples.length)];
  const positions: number[] = [];
  if (sample !== undefined) {
    const base = run.side * (course.outerHalfWidth + CORNER_STAND_SETBACK);
    const by = course.groundHeightAt(
      sample.x - sample.tangentZ * base,
      sample.z + sample.tangentX * base,
    );
    const at = (out: number, up: number): [number, number, number] => {
      const d = base + run.side * out;
      return [sample.x - sample.tangentZ * d, by + up, sample.z + sample.tangentX * d];
    };
    for (let tier = 0; tier < CORNER_STAND_TIERS; tier++) {
      const top = CORNER_STAND_FRONT_HEIGHT + tier * TIER_RISE;
      const a = at(tier * TIER_RUN, -SKIRT);
      const b = at((tier + 1) * TIER_RUN, -SKIRT);
      const c = at((tier + 1) * TIER_RUN, top);
      const d = at(tier * TIER_RUN, top);
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute(
    'uv',
    new BufferAttribute(new Float32Array((positions.length / 3) * 2), 2),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function createCornerStands(course: Course, palette: Palette, runs: readonly SideRun[]): Group {
  const group = new Group();
  group.name = 'corner-stands';
  const tiers: ProfilePoint[] = [];
  for (let i = 0; i <= CORNER_STAND_TIERS; i++) {
    const up = CORNER_STAND_FRONT_HEIGHT + i * TIER_RISE;
    // 人群贴图纵向四排一循环,和主看台同一个比例。
    tiers.push({ out: i * TIER_RUN, up, v: i / 4 });
    if (i < CORNER_STAND_TIERS) {
      tiers.push({ out: (i + 1) * TIER_RUN, up, v: (i + 0.45) / 4 });
    }
  }
  const top = CORNER_STAND_FRONT_HEIGHT + CORNER_STAND_TIERS * TIER_RISE;
  const shell: ProfilePoint[] = [
    { out: 0, up: CORNER_STAND_FRONT_HEIGHT, v: 0 },
    { out: 0, up: -SKIRT, v: 0 },
    { out: CORNER_STAND_DEPTH, up: -SKIRT, v: 0 },
    { out: CORNER_STAND_DEPTH, up: top + CORNER_STAND_RAIL, v: 0 },
  ];
  const crowds: BufferGeometry[] = [];
  const shells: BufferGeometry[] = [];
  for (const run of runs) {
    const rows = rowRange(run);
    const baseOut = (): number => course.outerHalfWidth + CORNER_STAND_SETBACK;
    crowds.push(sweep(course, rows, run.side, baseOut, tiers, 1 / 8));
    shells.push(sweep(course, rows, run.side, baseOut, shell, 0));
    shells.push(standEndCap(course, run, run.from));
    shells.push(standEndCap(course, run, run.to));
  }
  const crowd = merged(crowds);
  if (crowd !== null) {
    const mesh = new Mesh(
      crowd,
      new MeshStandardMaterial({
        map: tiledTexture(crowdPixels(), 128, 128),
        roughness: 0.9,
        side: DoubleSide,
      }),
    );
    mesh.name = 'corner-stand-crowd';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const structure = merged(shells);
  if (structure !== null) {
    const mesh = new Mesh(
      structure,
      new MeshStandardMaterial({ color: palette.wallCap, roughness: 0.85, side: DoubleSide }),
    );
    mesh.name = 'corner-stand-structure';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** 一个带顶点色的盒子:几样零件合成一个几何体之后还能各有各的颜色,省材质也省 draw call。 */
function tintedBox(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  colour: number,
): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  const tint = new Color(colour);
  const count = geometry.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colours[i * 3] = tint.r;
    colours[i * 3 + 1] = tint.g;
    colours[i * 3 + 2] = tint.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  return geometry;
}

/** 灯柱:局部 +X 是灯臂伸出去的方向(朝赛道)。柱脚往地下多埋一米。 */
function lampGeometry(): BufferGeometry {
  const steel = 0x8b8e92;
  return mergeGeometries([
    tintedBox(0.18, LAMP_HEIGHT + 1, 0.18, 0, (LAMP_HEIGHT - 1) / 2, 0, steel),
    tintedBox(LAMP_ARM, 0.12, 0.12, LAMP_ARM / 2, LAMP_HEIGHT - 0.06, 0, steel),
    tintedBox(0.9, 0.14, 0.4, LAMP_ARM - 0.3, LAMP_HEIGHT - 0.19, 0, 0x2e3034),
  ]);
}

/** 裁判岗亭:底座、半人高的橙色围挡、四根角柱撑一块顶板。 */
function marshalGeometry(): BufferGeometry {
  const s = MARSHAL_SIZE;
  const wall = 1;
  const open = 1;
  const parts = [
    tintedBox(s - 0.2, MARSHAL_FLOOR + 1, s - 0.2, 0, (MARSHAL_FLOOR - 1) / 2, 0, 0x4a4c50),
    tintedBox(s, wall, s, 0, MARSHAL_FLOOR + wall / 2, 0, 0xc9541c),
    tintedBox(s + 0.4, 0.1, s + 0.4, 0, MARSHAL_FLOOR + wall + open + 0.05, 0, 0xd8d6ce),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(
        tintedBox(
          0.08,
          open,
          0.08,
          (sx * (s - 0.08)) / 2,
          MARSHAL_FLOOR + wall + open / 2,
          (sz * (s - 0.08)) / 2,
          0x4a4c50,
        ),
      );
    }
  }
  return mergeGeometries(parts);
}

function createInstances(
  name: string,
  course: Course,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  sites: readonly { row: number; side: -1 | 1 }[],
  offset: number,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, sites.length);
  mesh.name = name;
  mesh.castShadow = true;
  const samples = course.layout.samples;
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const up = new Vector3(0, 1, 0);
  sites.forEach((site, i) => {
    const sample = samples[site.row];
    if (sample === undefined) {
      return;
    }
    const d = site.side * (course.outerHalfWidth + offset);
    const x = sample.x - sample.tangentZ * d;
    const z = sample.z + sample.tangentX * d;
    position.set(x, course.groundHeightAt(x, z), z);
    // 局部 +X 转到「朝赛道」:赛道在这一侧的反方向。
    rotation.setFromAxisAngle(
      up,
      Math.atan2(-site.side * sample.tangentX, -site.side * sample.tangentZ),
    );
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  // 实例散在整条赛道上,原始几何体的包围球只罩得住原点那一个。
  mesh.computeBoundingSphere();
  return mesh;
}

export function createTrackside(course: Course, palette: Palette, pit: PitLane | null): Group {
  const group = new Group();
  group.name = 'trackside';
  const plan = planTrackside(course, pit);
  group.add(createHoardings(course, plan.hoardings));
  group.add(createCornerStands(course, palette, plan.stands));
  if (plan.lamps.length > 0) {
    group.add(
      createInstances(
        'lamp-posts',
        course,
        lampGeometry(),
        new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.6 }),
        plan.lamps.map((row) => ({ row, side: -1 as const })),
        LAMP_OFFSET,
      ),
    );
  }
  if (plan.marshals.length > 0) {
    group.add(
      createInstances(
        'marshal-posts',
        course,
        marshalGeometry(),
        new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
        plan.marshals,
        MARSHAL_OFFSET,
      ),
    );
  }
  return group;
}
