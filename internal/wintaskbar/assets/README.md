# wintaskbar assets

`prev.ico` / `next.ico` はサムネイルツールバーボタン用の ◀▶ アイコン (16/20/24/32px の
PNG エントリ入り ICO、中間グレー #A0A0A0)。再生成する場合は Go の `image/png` +
`golang.org/x/image/draw` で三角形を 16 倍描画 → 縮小 → ICONDIR に PNG エントリを並べる
使い捨てスクリプトを書く (spec-taskbar-viewer-switch.md §5.3。初回生成スクリプトは
PR #149 のブランチ履歴ではなく、この手順メモだけを残す方針)。
