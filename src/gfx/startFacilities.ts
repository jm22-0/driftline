import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  UnsignedByteType,
} from 'three';
import type { Course } from '../game/course';
import type { PitLane } from '../game/pitLane';
import type { Palette } from './palette';

/**
 * 起跑直道上的设施:主看台、发车龙门架和起跑灯、维修区建筑。
 *
 * 全部立在护墙**外面**,所以不做碰撞 —— 车到不了那儿。全部**不消耗随机数**:
 * 人群的颜色用整数哈希算,不走注入的 PRNG(那会改动 `World` 里后面所有东西拿到的
 * 随机序列)。
 *
 * 造型是这一类东西里程序化做得像的那一半:看台、龙门架、车库都是方盒子和台阶。
 * 人群近看是贴图,不是一个个人 —— CLAUDE.md 说的那条天花板。
 */

/** 龙门架立在起跑线前方第几行。24 米:追尾机位起步时灯在画面上方,不出框。 */
export const GANTRY_ROW = 4;
/** 横梁下沿离路面多高(米)。 */
const GANTRY_CLEARANCE = 6.2;
const GANTRY_BEAM = 0.5;
const GANTRY_POST = 0.4;
/** 立柱中心离条带外缘多远(米):正好落在护墙的厚度里(0.55 米),不占路肩也不占维修道。 */
const GANTRY_POST_OFFSET = 0.28;
export const START_LAMP_COUNT = 5;
const LAMP_RADIUS = 0.24;
const LAMP_SPACING = 0.75;

/** 主看台:起跑线前后各几行(一行 6 米)。 */
const STAND_ROWS_BEFORE = 7;
const STAND_ROWS_AFTER = 6;
/** 看台前沿离条带外缘多远(米)。护墙厚 0.55,再留一条走道。 */
export const STAND_SETBACK = 3;
const STAND_TIERS = 10;
const STAND_TIER_RUN = 0.85;
const STAND_TIER_RISE = 0.5;
/** 第一排座位离地多高(米):要高过护墙(1.08 米),不然第一排看的是墙。 */
const STAND_FRONT_HEIGHT = 1.4;
/** 地形不平:结构往地面以下多埋这么深,免得悬空露缝。 */
const SKIRT = 3;

/** 维修区建筑离维修道外缘多远(米)、进深、檐高。 */
export const GARAGE_SETBACK = 1.6;
const GARAGE_DEPTH = 8;
const GARAGE_HEIGHT = 5.6;
/** 一个车库开间的宽度(米)。贴图按它平铺。 */
const GARAGE_BAY = 6;

/** 32 位整数哈希 → [0, 1)。给人群上色用,和世界生成的随机序列无关。 */
function hash01(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const CROWD_SIZE = 128;
/** 贴图横向一格几个座位、纵向几排。 */
const CROWD_SEATS = 16;
const CROWD_ROWS = 4;

/**
 * 人群贴图:每个座位一个「头 + 上身」的色块,约八成上座。导出给单测。
 *
 * 颜色故意压得不饱和:远处的人群在照片里是一片带噪点的灰彩色,不是彩纸屑。
 */
export function crowdPixels(): Uint8Array {
  const data = new Uint8Array(CROWD_SIZE * CROWD_SIZE * 4);
  const seatWidth = CROWD_SIZE / CROWD_SEATS;
  const rowHeight = CROWD_SIZE / CROWD_ROWS;
  for (let y = 0; y < CROWD_SIZE; y++) {
    for (let x = 0; x < CROWD_SIZE; x++) {
      const seat = Math.floor(x / seatWidth);
      const row = Math.floor(y / rowHeight);
      const fx = (x % seatWidth) / seatWidth;
      // 贴图第 0 行在底部:一排里 fy 小的是台阶面(腿和座椅),大的是上身和头。
      const fy = (y % rowHeight) / rowHeight;
      const occupied = hash01(seat, row, 1) < 0.82;
      let r = 46;
      let g = 50;
      let b = 58;
      if (occupied && fx > 0.14 && fx < 0.86) {
        if (fy > 0.72 && fx > 0.3 && fx < 0.7) {
          // 头:肤色和发色混着来。
          const tone = hash01(seat, row, 2);
          r = 70 + tone * 110;
          g = 52 + tone * 84;
          b = 40 + tone * 62;
        } else if (fy > 0.3) {
          const hue = hash01(seat, row, 3);
          const light = 0.35 + hash01(seat, row, 4) * 0.5;
          r = (105 + 80 * Math.abs(Math.sin(hue * 6.283))) * light;
          g = (105 + 80 * Math.abs(Math.sin(hue * 6.283 + 2.1))) * light;
          b = (105 + 80 * Math.abs(Math.sin(hue * 6.283 + 4.2))) * light;
        }
      }
      const o = (y * CROWD_SIZE + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return data;
}

const GARAGE_TEX_WIDTH = 96;
const GARAGE_TEX_HEIGHT = 64;

/**
 * 车库正立面贴图,一个开间:中间一扇深色卷帘门,上面一条玻璃带。导出给单测。
 * 最左边一列是纯墙色 —— 屋顶和背面的 UV 都指到那一列,省一个材质。
 */
export function garagePixels(): Uint8Array {
  const data = new Uint8Array(GARAGE_TEX_WIDTH * GARAGE_TEX_HEIGHT * 4);
  for (let y = 0; y < GARAGE_TEX_HEIGHT; y++) {
    for (let x = 0; x < GARAGE_TEX_WIDTH; x++) {
      const u = x / GARAGE_TEX_WIDTH;
      const v = y / GARAGE_TEX_HEIGHT;
      let r = 168;
      let g = 170;
      let b = 172;
      if (u > 0.16 && u < 0.84 && v < 0.58) {
        // 卷帘门:深灰,带横向的叶片纹。
        const slat = y % 4 === 0 ? 10 : 0;
        r = 38 + slat;
        g = 40 + slat;
        b = 44 + slat;
      } else if (v > 0.68 && v < 0.9 && u > 0.05) {
        // 玻璃带:偏蓝的深色,竖框把它分成几格。
        const mullion = x % 16 === 0;
        r = mullion ? 120 : 42;
        g = mullion ? 122 : 62;
        b = mullion ? 124 : 84;
      }
      const o = (y * GARAGE_TEX_WIDTH + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return data;
}

function tiledTexture(data: Uint8Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** 剖面上的一个点:`out` 从基线向外(米),`up` 从基线地面向上(米),`v` 是贴图纵坐标。 */
interface ProfilePoint {
  out: number;
  up: number;
  v: number;
}

/**
 * 把一个横截面沿赛道扫出来。
 *
 * `rows` 是**不回绕**的行号(可以是负数,看台从起跑线后面开始);`side` 是
 * `Course` 的横向符号;`baseOut(row)` 是剖面基线离中心线多远。每一段剖面线出
 * 一条四边形带,法线用面法线 —— 这些都是折面结构,不要平滑。
 *
 * `uPerMetre` 为 0 时这一带的 u 固定在 `uConstant`(指向贴图里的一块纯色)。
 */
function sweep(
  course: Course,
  rows: readonly number[],
  side: -1 | 1,
  baseOut: (row: number) => number,
  profile: readonly ProfilePoint[],
  uPerMetre: number,
  uConstant = 0,
): BufferGeometry {
  const samples = course.layout.samples;
  const count = samples.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const ring = (row: number): { x: number; y: number; z: number }[] => {
    const sample = samples[((row % count) + count) % count];
    if (sample === undefined) {
      return [];
    }
    const base = side * baseOut(row);
    const bx = sample.x - sample.tangentZ * base;
    const bz = sample.z + sample.tangentX * base;
    const by = course.groundHeightAt(bx, bz);
    return profile.map((point) => {
      const d = base + side * point.out;
      return { x: sample.x - sample.tangentZ * d, y: by + point.up, z: sample.z + sample.tangentX * d };
    });
  };
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = ring(rows[i] ?? 0);
    const b = ring(rows[i + 1] ?? 0);
    const u0 = uPerMetre === 0 ? uConstant : i * course.layout.spacing * uPerMetre;
    const u1 = uPerMetre === 0 ? uConstant : (i + 1) * course.layout.spacing * uPerMetre;
    for (let j = 0; j + 1 < profile.length; j++) {
      const p00 = a[j];
      const p01 = a[j + 1];
      const p10 = b[j];
      const p11 = b[j + 1];
      const v0 = profile[j]?.v ?? 0;
      const v1 = profile[j + 1]?.v ?? 0;
      if (p00 === undefined || p01 === undefined || p10 === undefined || p11 === undefined) {
        continue;
      }
      positions.push(p00.x, p00.y, p00.z, p01.x, p01.y, p01.z, p10.x, p10.y, p10.z);
      positions.push(p10.x, p10.y, p10.z, p01.x, p01.y, p01.z, p11.x, p11.y, p11.z);
      uvs.push(u0, v0, u0, v1, u1, v0, u1, v0, u0, v1, u1, v1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeVertexNormals();
  return geometry;
}

function rowRange(from: number, to: number): number[] {
  const rows: number[] = [];
  for (let row = from; row <= to; row++) {
    rows.push(row);
  }
  return rows;
}

function createGrandstand(course: Course, palette: Palette): Group {
  const group = new Group();
  group.name = 'grandstand';
  const rows = rowRange(-STAND_ROWS_BEFORE, STAND_ROWS_AFTER);
  const baseOut = (): number => course.outerHalfWidth + STAND_SETBACK;

  // 座位区:一级一级的台阶,每级的踏面 + 踢面占人群贴图里的一排。
  const tiers: ProfilePoint[] = [];
  for (let i = 0; i <= STAND_TIERS; i++) {
    const up = STAND_FRONT_HEIGHT + i * STAND_TIER_RISE;
    tiers.push({ out: i * STAND_TIER_RUN, up, v: i / CROWD_ROWS });
    if (i < STAND_TIERS) {
      tiers.push({ out: (i + 1) * STAND_TIER_RUN, up, v: (i + 0.45) / CROWD_ROWS });
    }
  }
  const crowd = new Mesh(
    // 贴图一格 8 米宽、16 个座位:一个座位 0.5 米。
    sweep(course, rows, -1, baseOut, tiers, 1 / 8),
    new MeshStandardMaterial({
      map: tiledTexture(crowdPixels(), CROWD_SIZE, CROWD_SIZE),
      roughness: 0.9,
      side: DoubleSide,
    }),
  );
  crowd.name = 'grandstand-crowd';
  crowd.receiveShadow = true;
  group.add(crowd);

  const depth = STAND_TIERS * STAND_TIER_RUN;
  const top = STAND_FRONT_HEIGHT + STAND_TIERS * STAND_TIER_RISE;
  const roof = top + 3.2;
  // 结构:前墙、后墙、挑出去的顶棚(上下两面)。
  const shell: ProfilePoint[] = [
    { out: 0, up: STAND_FRONT_HEIGHT, v: 0 },
    { out: 0, up: -SKIRT, v: 0 },
    { out: depth + 0.4, up: -SKIRT, v: 0 },
    { out: depth + 0.4, up: roof, v: 0 },
    { out: -1.5, up: roof + 1.1, v: 0 },
    { out: -1.5, up: roof + 1.35, v: 0 },
    { out: depth + 0.4, up: roof + 0.25, v: 0 },
  ];
  const structure = new Mesh(
    sweep(course, rows, -1, baseOut, shell, 0),
    new MeshStandardMaterial({ color: palette.wallCap, roughness: 0.85, side: DoubleSide }),
  );
  structure.name = 'grandstand-structure';
  structure.castShadow = true;
  structure.receiveShadow = true;
  group.add(structure);
  return group;
}

function createGarages(course: Course, pit: PitLane): Mesh {
  const rows: number[] = [];
  const span = (((pit.boxEndRow - pit.boxStartRow) % pit.rowCount) + pit.rowCount) % pit.rowCount;
  // 车位前后各多盖两行:真实的维修区建筑比单个车位长得多。
  for (let i = -2; i <= span + 3; i++) {
    rows.push(pit.boxStartRow + i);
  }
  const profile: ProfilePoint[] = [
    { out: 0, up: -SKIRT, v: -SKIRT / GARAGE_HEIGHT },
    { out: 0, up: GARAGE_HEIGHT, v: 1 },
  ];
  const facade = sweep(
    course,
    rows,
    1,
    () => pit.lateralMax + GARAGE_SETBACK,
    profile,
    1 / GARAGE_BAY,
  );
  // 屋顶和背面:u 固定在贴图最左边那一列纯墙色。
  const box: ProfilePoint[] = [
    { out: 0, up: GARAGE_HEIGHT, v: 0.62 },
    { out: GARAGE_DEPTH, up: GARAGE_HEIGHT, v: 0.62 },
    { out: GARAGE_DEPTH, up: -SKIRT, v: 0.62 },
  ];
  const rest = sweep(course, rows, 1, () => pit.lateralMax + GARAGE_SETBACK, box, 0, 0.02);
  const merged = new BufferGeometry();
  for (const name of ['position', 'uv', 'normal'] as const) {
    const a = facade.getAttribute(name);
    const b = rest.getAttribute(name);
    const array = new Float32Array(a.array.length + b.array.length);
    array.set(a.array as Float32Array, 0);
    array.set(b.array as Float32Array, a.array.length);
    merged.setAttribute(name, new BufferAttribute(array, a.itemSize));
  }
  const mesh = new Mesh(
    merged,
    new MeshStandardMaterial({
      map: tiledTexture(garagePixels(), GARAGE_TEX_WIDTH, GARAGE_TEX_HEIGHT),
      roughness: 0.8,
      side: DoubleSide,
    }),
  );
  mesh.name = 'pit-garages';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const LAMP_OFF = new Color(0x1a0303);
const LAMP_ON = new Color(0xff1a10);

function createGantry(course: Course): Group {
  const group = new Group();
  group.name = 'start-gantry';
  const sample = course.layout.samples[GANTRY_ROW % course.layout.samples.length];
  if (sample === undefined) {
    return group;
  }
  const yaw = Math.atan2(sample.tangentX, sample.tangentZ);
  const reach = course.outerHalfWidth + GANTRY_POST_OFFSET;
  const steel = new MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.55, metalness: 0.7 });
  const beamY = sample.y + GANTRY_CLEARANCE + GANTRY_BEAM / 2;

  for (const side of [-1, 1] as const) {
    const d = side * reach;
    const x = sample.x - sample.tangentZ * d;
    const z = sample.z + sample.tangentX * d;
    const ground = course.groundHeightAt(x, z);
    const height = beamY + GANTRY_BEAM / 2 - ground + 1;
    const post = new Mesh(new BoxGeometry(GANTRY_POST, height, GANTRY_POST), steel);
    post.position.set(x, ground - 1 + height / 2, z);
    post.rotation.y = yaw;
    post.castShadow = true;
    group.add(post);
  }

  // 盒子的 X 轴转过 yaw 之后正好横跨赛道。
  const beam = new Mesh(new BoxGeometry(reach * 2 + GANTRY_POST, GANTRY_BEAM, GANTRY_BEAM), steel);
  beam.position.set(sample.x, beamY, sample.z);
  beam.rotation.y = yaw;
  beam.castShadow = true;
  group.add(beam);

  // 灯箱挂在横梁下面,正面朝着发车格(负的切线方向)。
  const panelWidth = LAMP_SPACING * (START_LAMP_COUNT - 1) + 1.1;
  const panelY = beamY - GANTRY_BEAM / 2 - 0.45;
  const panel = new Mesh(
    new BoxGeometry(panelWidth, 0.9, 0.3),
    new MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.7 }),
  );
  panel.position.set(sample.x, panelY, sample.z);
  panel.rotation.y = yaw;
  group.add(panel);

  const lamps: MeshStandardMaterial[] = [];
  const lampGeometry = new SphereGeometry(LAMP_RADIUS, 12, 8);
  for (let i = 0; i < START_LAMP_COUNT; i++) {
    const across = (i - (START_LAMP_COUNT - 1) / 2) * LAMP_SPACING;
    const material = new MeshStandardMaterial({
      color: LAMP_OFF,
      emissive: LAMP_ON,
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    const lamp = new Mesh(lampGeometry, material);
    lamp.position.set(
      sample.x - sample.tangentZ * across - sample.tangentX * 0.17,
      panelY,
      sample.z + sample.tangentX * across - sample.tangentZ * 0.17,
    );
    group.add(lamp);
    lamps.push(material);
  }
  group.userData['lamps'] = lamps;
  return group;
}

/** 起跑灯的材质,按从左到右的顺序。没有龙门架(平地场)时是空数组。 */
export function findStartLamps(root: Group | null): MeshStandardMaterial[] {
  const gantry = root?.getObjectByName('start-gantry');
  const lamps: unknown = gantry?.userData['lamps'];
  return Array.isArray(lamps) ? (lamps as MeshStandardMaterial[]) : [];
}

/**
 * 倒计时还剩 `remaining` 秒(共 `total` 秒)时该亮几盏。
 *
 * 和真实的发车程序一样:灯一盏一盏亮起来,全亮之后**一起灭**就是发车。
 * 所以倒计时走完(`remaining` ≤ 0)返回 0,不是 5。
 */
export function startLampsLit(remaining: number, total: number): number {
  if (remaining <= 0 || total <= 0) {
    return 0;
  }
  const elapsed = Math.min(1, Math.max(0, 1 - remaining / total));
  return Math.min(START_LAMP_COUNT, Math.floor(elapsed * START_LAMP_COUNT) + 1);
}

/** 点亮前 `lit` 盏。每步调用,不分配。 */
export function setStartLamps(lamps: readonly MeshStandardMaterial[], lit: number): void {
  for (let i = 0; i < lamps.length; i++) {
    const lamp = lamps[i];
    if (lamp !== undefined) {
      // 亮度给到 bloom 阈值以上,灯才会有一圈光晕。
      lamp.emissiveIntensity = i < lit ? 4 : 0;
    }
  }
}

export function createStartFacilities(course: Course, palette: Palette, pit: PitLane | null): Group {
  const group = new Group();
  group.name = 'start-facilities';
  group.add(createGrandstand(course, palette));
  group.add(createGantry(course));
  if (pit !== null) {
    group.add(createGarages(course, pit));
  }
  return group;
}
