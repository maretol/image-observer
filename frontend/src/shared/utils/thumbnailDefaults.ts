import { GetThumbnail } from "../../../wailsjs/go/main/App";
import type { thumb } from "../../../wailsjs/go/models";

// プレビュー (= ImageView の original 到着待ち一時表示 / SampleModal の
// プレビュー) 用サイズとモード。GetThumbnail の引数として両者が同じ値を
// 渡すことで、Go 側のディスクキャッシュ + thumb.pool inflight dedup が
// 自然に効く (path/mtime/size/mode 一致で同じディスクファイル参照 + 並行
// リクエストは 1 ジョブに合流)。
//
// AGENTS.md D-1: 同概念の数値リテラルが複数箇所に散らないよう、必ずこの
// 定数 or 下の getPreview() ラッパ経由で呼び出す。
export const PREVIEW_SIZE = 1024;
export const PREVIEW_MODE = "letterbox";

// 「ビューア / モーダルの一時プレビュー」用ラッパ。GetThumbnail は本来
// 一覧グリッドの 256px サムネ用 API だが、同じディスクキャッシュ機構を
// 1024px プレビューにも流用している (#97)。意味的には "thumbnail" では
// なく "preview" なので、call site の意図を明示するためこの関数を経由
// する。実装は GetThumbnail への薄い委譲。
export function getPreview(path: string): Promise<thumb.Result> {
  return GetThumbnail(path, PREVIEW_SIZE, PREVIEW_MODE);
}

// preview Blob URL を revoke するまでの遅延 (ms)。
//
// React の commit 後に <img src> が swap されるのを待ってから旧 URL を
// 破棄する目的。即時 revoke だと unmount / tab.path 切替の瞬間にブラウザ
// がまだ旧 src を参照していて描画が崩れる可能性がある。
//
// 値は 60Hz 想定で 1-2 frame (~16.7〜33ms) より大きく、人間の知覚閾値
// (~100ms) 以下に収めて余分なメモリ保持を最小化。
//
// AGENTS.md D-1 (同概念の定数が複数箇所に分散しないよう shared 集約):
// ImageView の useEffect cleanup と previewCache の LRU evict 遅延の
// 両方が同じ値を参照する。
export const PREVIEW_REVOKE_DELAY_MS = 100;
