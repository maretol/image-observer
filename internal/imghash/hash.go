// Package imghash は保存画像のダブり (知覚的に近い画像ペア) 検出を提供する (#136,
// docs/spec-duplicate-detection.md)。知覚的ハッシュの計算・フォルダ単位のディスクキャッシュ・
// しきい値によるペア抽出・dismiss (「ダブりではない」判定) の永続化を担う。
// Phase 1 のアルゴリズムは dHash のみ (pHash + 切替は Phase 2, spec §12)。
package imghash

import (
	"fmt"
	"image"
	"image/color"
	"math/bits"
	"strconv"

	"golang.org/x/image/draw"
)

// AlgoDHash はキャッシュのパスセグメント / dismiss エントリの algo 値。Phase 2 で "phash" が
// 加わる (spec §7.2 / §7.3)。
const AlgoDHash = "dhash"

// dhashRevision は index 内の実装リビジョンタグ。ビット順や縮小パラメータを変えたら bump し、
// 不一致の index を全捨て → 再計算させる (spec §7.3。パスセグメントは algo 種別、タグは実装版数)。
const dhashRevision = "dhash-v1"

// DHash は 9×8 グレースケール縮小 → 各行の隣接輝度比較で 64bit の知覚的ハッシュを返す (spec §2)。
// bit は y=0 行の x=0..1 比較を MSB として行順に詰め、「左 < 右」を 1 とする。この bit 配置は
// dhashRevision で pin される契約 — 変えるときは revision bump (テストの golden も更新)。
func DHash(src image.Image) uint64 {
	small := image.NewRGBA(image.Rect(0, 0, 9, 8))
	draw.BiLinear.Scale(small, small.Bounds(), src, src.Bounds(), draw.Src, nil)
	var h uint64
	for y := range 8 {
		left := luma(small.RGBAAt(0, y))
		for x := 1; x < 9; x++ {
			right := luma(small.RGBAAt(x, y))
			h <<= 1
			if left < right {
				h |= 1
			}
			left = right
		}
	}
	return h
}

// luma は ITU-R BT.601 の輝度近似。
func luma(c color.RGBA) float64 {
	return 0.299*float64(c.R) + 0.587*float64(c.G) + 0.114*float64(c.B)
}

// Distance は 2 ハッシュのハミング距離 (0〜64) を返す。しきい値以下がダブり候補 (spec §2)。
func Distance(a, b uint64) int {
	return bits.OnesCount64(a ^ b)
}

// hashHex / parseHashHex は index / _duplicates.json に載せる 16 桁 hex 形。
func hashHex(h uint64) string {
	return fmt.Sprintf("%016x", h)
}

func parseHashHex(s string) (uint64, bool) {
	if len(s) != 16 {
		return 0, false
	}
	v, err := strconv.ParseUint(s, 16, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
