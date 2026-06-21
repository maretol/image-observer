package winplacement

import (
	"testing"

	"image-observer/internal/state"
)

func TestToWindowState(t *testing.T) {
	tests := []struct {
		name                     string
		left, top, right, bottom int
		maximized                bool
		want                     state.WindowState
	}{
		{
			name: "normal window",
			left: 100, top: 50, right: 1124, bottom: 818,
			maximized: false,
			want:      state.WindowState{X: 100, Y: 50, Width: 1024, Height: 768, Maximized: false},
		},
		{
			name: "maximized keeps restore rect",
			left: 200, top: 200, right: 1000, bottom: 800,
			maximized: true,
			want:      state.WindowState{X: 200, Y: 200, Width: 800, Height: 600, Maximized: true},
		},
		{
			name: "negative origin (secondary monitor left of primary)",
			left: -1920, top: 0, right: -896, bottom: 768,
			maximized: false,
			want:      state.WindowState{X: -1920, Y: 0, Width: 1024, Height: 768, Maximized: false},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ToWindowState(tt.left, tt.top, tt.right, tt.bottom, tt.maximized)
			if got != tt.want {
				t.Errorf("ToWindowState(%d,%d,%d,%d,%v) = %+v, want %+v",
					tt.left, tt.top, tt.right, tt.bottom, tt.maximized, got, tt.want)
			}
		})
	}
}

func TestFromWindowState(t *testing.T) {
	tests := []struct {
		name                       string
		in                         state.WindowState
		wantL, wantT, wantR, wantB int
		wantMax                    bool
	}{
		{
			name:  "normal window",
			in:    state.WindowState{X: 100, Y: 50, Width: 1024, Height: 768, Maximized: false},
			wantL: 100, wantT: 50, wantR: 1124, wantB: 818, wantMax: false,
		},
		{
			name:  "maximized",
			in:    state.WindowState{X: 0, Y: 0, Width: 1280, Height: 1024, Maximized: true},
			wantL: 0, wantT: 0, wantR: 1280, wantB: 1024, wantMax: true,
		},
		{
			name:  "negative origin",
			in:    state.WindowState{X: -1920, Y: 0, Width: 1024, Height: 768},
			wantL: -1920, wantT: 0, wantR: -896, wantB: 768, wantMax: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l, top, r, b, max := FromWindowState(tt.in)
			if l != tt.wantL || top != tt.wantT || r != tt.wantR || b != tt.wantB || max != tt.wantMax {
				t.Errorf("FromWindowState(%+v) = (%d,%d,%d,%d,%v), want (%d,%d,%d,%d,%v)",
					tt.in, l, top, r, b, max, tt.wantL, tt.wantT, tt.wantR, tt.wantB, tt.wantMax)
			}
		})
	}
}

// TestRoundTrip pins the invariant the restore path relies on: capturing a
// placement and feeding it back yields the same rectangle + maximized flag.
func TestRoundTrip(t *testing.T) {
	cases := []state.WindowState{
		{X: 100, Y: 50, Width: 1024, Height: 768, Maximized: false},
		{X: -1920, Y: -200, Width: 800, Height: 600, Maximized: true},
		{X: 0, Y: 0, Width: 1280, Height: 1024, Maximized: false},
	}
	for _, want := range cases {
		l, top, r, b, max := FromWindowState(want)
		got := ToWindowState(l, top, r, b, max)
		if got != want {
			t.Errorf("round trip mismatch: got %+v, want %+v", got, want)
		}
	}
}
