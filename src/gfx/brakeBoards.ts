import {
  BoxGeometry,
  DataTexture,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { Course } from '../game/course';
import { type PitLane, pitRowIndex } from '../game/pitLane';
import { cornerRowMask, rowCurvature } from './corners';

/**
 * 刹车距离牌:入弯前 200 / 100 / 50 米各一块,立在护墙外面。
 *
 * 真实赛道每个要减速的弯前都有,车手靠它找刹车点。这里它还有第二个用处:
 * 赛道是按 seed 生成的,玩家没有「背过这条赛道」这回事,牌子是除了小地图以外
 * 唯一提前告诉你「前面有弯」的东西。
 *
 * 立在墙**外**:墙内是路肩,车开得上去,立在那儿就得做碰撞。
 */
export const BRAKE_BOARD_DISTANCES: readonly number[] = [200, 100, 50];

const PANEL_WIDTH = 1.8;
const PANEL_HEIGHT = 1.1;
const PANEL_THICKNESS = 0.05;
/** 牌面中心离地高度(米)。护墙高 1.08,牌面下沿要露在墙顶之上。 */
const PANEL_CENTRE_HEIGHT = 2.3;
const POST_SIZE = 0.09;
/** 立柱中心离条带外缘多远(米)。护墙厚 0.55。 */
const OUTSIDE_WALL = 1.3;

export interface BrakeBoard {
  /** 牌子所在的行。 */
  row: number;
  /** 它为之报距离的弯从哪一行开始。 */
  cornerRow: number;
  distance: number;
  /** 立在哪一侧:`Course` 的横向符号。 */
  side: -1 | 1;
}

/**
 * 牌子立在哪。导出给单测。
 *
 * - 弯的起点 = `cornerRowMask()` 从 0 变 1 的那一行。
 * - 牌子到弯之间必须全是直道:连续弯里第二个弯前面没有「200 米直道」,硬立一块
 *   牌子反而是错的信息。
 * - 立在弯的外侧(车手入弯前贴着的那一边);那一侧是维修道就换到另一侧。
 */
export function placeBrakeBoards(course: Course, pit: PitLane | null): BrakeBoard[] {
  const mask = cornerRowMask(course);
  const count = mask.length;
  const spacing = course.layout.spacing;
  const boards: BrakeBoard[] = [];
  for (let cornerRow = 0; cornerRow < count; cornerRow++) {
    const previous = (cornerRow - 1 + count) % count;
    if ((mask[cornerRow] ?? 0) === 0 || (mask[previous] ?? 0) !== 0) {
      continue;
    }
    // 弯里曲率最大的那几行决定往哪边拐;起点那一行本身曲率还没起来。
    let turn = 0;
    for (let r = cornerRow; (mask[r % count] ?? 0) !== 0 && r < cornerRow + count; r++) {
      const k = rowCurvature(course, r % count);
      if (Math.abs(k) > Math.abs(turn)) {
        turn = k;
      }
    }
    for (const distance of BRAKE_BOARD_DISTANCES) {
      const back = Math.round(distance / spacing);
      let straight = true;
      for (let i = 1; i <= back; i++) {
        if ((mask[(((cornerRow - i) % count) + count) % count] ?? 0) !== 0) {
          straight = false;
          break;
        }
      }
      if (!straight) {
        break;
      }
      const row = (((cornerRow - back) % count) + count) % count;
      let side: -1 | 1 = turn > 0 ? -1 : 1;
      // 维修道铺在横向正的那一侧(`pitLane.ts`)。
      if (side === 1 && pit !== null && pitRowIndex(pit, row) >= 0) {
        side = -1;
      }
      boards.push({ row, cornerRow, distance, side });
    }
  }
  return boards;
}

/** 5×7 点阵数字。每行一个 5 位二进制数,高位在左。 */
const DIGITS: Readonly<Record<string, readonly number[]>> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
};

const TEXTURE_WIDTH = 80;
const TEXTURE_HEIGHT = 48;
const GLYPH_SCALE = 4;

/**
 * 牌面贴图:白底黑字。**程序化画出来的点阵**,不是字体文件。
 *
 * 导出给单测:字要真的在贴图里(深色像素占一个合理的比例)。
 */
export function brakeBoardPixels(text: string): Uint8Array {
  const data = new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4);
  // 白底不是纯白:户外的牌子晒过、落过灰,而且纯白在 bloom 下会发光。
  data.fill(255);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 214;
    data[i + 1] = 212;
    data[i + 2] = 204;
  }
  const glyphWidth = 5 * GLYPH_SCALE;
  const gap = GLYPH_SCALE;
  const total = text.length * glyphWidth + (text.length - 1) * gap;
  const left = Math.floor((TEXTURE_WIDTH - total) / 2);
  const top = Math.floor((TEXTURE_HEIGHT - 7 * GLYPH_SCALE) / 2);
  for (let c = 0; c < text.length; c++) {
    const glyph = DIGITS[text[c] ?? ''];
    if (glyph === undefined) {
      continue;
    }
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (((glyph[gy] ?? 0) >> (4 - gx)) % 2 === 0) {
          continue;
        }
        for (let y = 0; y < GLYPH_SCALE; y++) {
          for (let x = 0; x < GLYPH_SCALE; x++) {
            const px = left + c * (glyphWidth + gap) + gx * GLYPH_SCALE + x;
            // DataTexture 的第 0 行在贴图底部,字要倒着写进去才是正的。
            const py = TEXTURE_HEIGHT - 1 - (top + gy * GLYPH_SCALE + y);
            const o = (py * TEXTURE_WIDTH + px) * 4;
            data[o] = 18;
            data[o + 1] = 18;
            data[o + 2] = 20;
          }
        }
      }
    }
  }
  return data;
}

function boardTexture(text: string): DataTexture {
  const texture = new DataTexture(
    brakeBoardPixels(text),
    TEXTURE_WIDTH,
    TEXTURE_HEIGHT,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function createBrakeBoards(course: Course, pit: PitLane | null): Group {
  const group = new Group();
  group.name = 'brake-boards';
  const boards = placeBrakeBoards(course, pit);
  if (boards.length === 0) {
    return group;
  }

  const samples = course.layout.samples;
  const postHeight = PANEL_CENTRE_HEIGHT + PANEL_HEIGHT / 2;
  const postGeometry = new BoxGeometry(POST_SIZE, postHeight, POST_SIZE);
  const panelGeometry = new BoxGeometry(PANEL_WIDTH, PANEL_HEIGHT, PANEL_THICKNESS);
  const posts = new InstancedMesh(
    postGeometry,
    new MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.6, metalness: 0.6 }),
    boards.length,
  );
  posts.name = 'brake-board-posts';
  posts.castShadow = true;

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const up = new Vector3(0, 1, 0);

  const base = (board: BrakeBoard): { x: number; y: number; z: number; yaw: number } => {
    const sample = samples[board.row];
    if (sample === undefined) {
      return { x: 0, y: 0, z: 0, yaw: 0 };
    }
    const d = board.side * (course.outerHalfWidth + OUTSIDE_WALL);
    const x = sample.x - sample.tangentZ * d;
    const z = sample.z + sample.tangentX * d;
    // 牌面(盒子的 +Z 面)朝着来车:法向 = 负的切线方向。
    const yaw = Math.atan2(-sample.tangentX, -sample.tangentZ);
    return { x, y: course.groundHeightAt(x, z), z, yaw };
  };

  boards.forEach((board, i) => {
    const at = base(board);
    position.set(at.x, at.y + postHeight / 2, at.z);
    rotation.setFromAxisAngle(up, at.yaw);
    matrix.compose(position, rotation, scale);
    posts.setMatrixAt(i, matrix);
  });
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  for (const distance of BRAKE_BOARD_DISTANCES) {
    const subset = boards.filter((board) => board.distance === distance);
    if (subset.length === 0) {
      continue;
    }
    const panels = new InstancedMesh(
      panelGeometry,
      new MeshStandardMaterial({ map: boardTexture(String(distance)), roughness: 0.55 }),
      subset.length,
    );
    panels.name = `brake-board-${distance}`;
    panels.castShadow = true;
    subset.forEach((board, i) => {
      const at = base(board);
      // 牌面贴在立柱朝来车的那一面,不和立柱穿插。
      const forward = POST_SIZE / 2 + PANEL_THICKNESS / 2;
      position.set(
        at.x + Math.sin(at.yaw) * forward,
        at.y + PANEL_CENTRE_HEIGHT,
        at.z + Math.cos(at.yaw) * forward,
      );
      rotation.setFromAxisAngle(up, at.yaw);
      matrix.compose(position, rotation, scale);
      panels.setMatrixAt(i, matrix);
    });
    panels.instanceMatrix.needsUpdate = true;
    group.add(panels);
  }
  return group;
}
