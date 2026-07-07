import { GetThumbnail } from "../../../wailsjs/go/main/App";
import type { thumb } from "../../../wailsjs/go/models";

// プレビュー (ImageView の original 待ち一時表示 / SampleModal) 用のサイズ・
// モード。両者が同じ値を渡すことで Go 側のディスクキャッシュ + thumb.pool の
// inflight dedup が効く (path/mtime/size/mode 一致で同一ファイル参照 + 並行
// リクエストは 1 ジョブに合流)。数値リテラルを散らさないよう、必ずこの定数か
// getPreview() 経由で呼ぶ (AGENTS.md D-1)。
export const PREVIEW_SIZE = 1024;
export const PREVIEW_MODE = "letterbox";

// プレビュー用ラッパ。GetThumbnail は本来一覧グリッドの 256px サムネ用 API だが、
// 同じディスクキャッシュ機構を 1024px プレビューに流用している (#97)。意味は
// "thumbnail" でなく "preview" なので、call site の意図を明示するため経由する。
export function getPreview(path: string): Promise<thumb.Result> {
  return GetThumbnail(path, PREVIEW_SIZE, PREVIEW_MODE);
}

// preview Blob URL を revoke するまでの遅延 (ms)。React commit 後に <img src> が
// swap されるのを待ってから旧 URL を破棄する。即時 revoke だと unmount / tab.path
// 切替の瞬間にブラウザが旧 src を参照していて描画が崩れうる。値は 1-2 frame
// (~16.7〜33ms) より大きく知覚閾値 (~100ms) 以下。ImageView の cleanup と
// previewCache の LRU evict 遅延が共有する (AGENTS.md D-1)。
export const PREVIEW_REVOKE_DELAY_MS = 100;
