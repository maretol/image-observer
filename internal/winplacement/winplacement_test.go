package winplacement

import (
	"math"
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
		wantL, wantT, wantR, wantB int32
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
		{
			// Absurdly corrupt state.json: X+Width would overflow int64 with a
			// naive add. FromWindowState must saturate, not wrap (issue #129 review).
			name:  "overflow-prone width saturates instead of wrapping",
			in:    state.WindowState{X: math.MaxInt, Y: 0, Width: math.MaxInt, Height: 768},
			wantL: math.MaxInt32, wantT: 0, wantR: math.MaxInt32, wantB: 768, wantMax: false,
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

func TestClampInt32(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int32
	}{
		{"in range", 1024, 1024},
		{"negative in range (secondary monitor)", -1920, -1920},
		{"zero", 0, 0},
		{"max boundary", math.MaxInt32, math.MaxInt32},
		{"min boundary", math.MinInt32, math.MinInt32},
		{"above max saturates", math.MaxInt32 + 1, math.MaxInt32},
		{"far above max saturates", math.MaxInt32 * 4, math.MaxInt32},
		{"below min saturates", math.MinInt32 - 1, math.MinInt32},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := clampInt32(tt.in); got != tt.want {
				t.Errorf("clampInt32(%d) = %d, want %d", tt.in, got, tt.want)
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
		// FromWindowState now returns int32 (saturated RECT edges); the in-range
		// cases above convert back losslessly.
		got := ToWindowState(int(l), int(top), int(r), int(b), max)
		if got != want {
			t.Errorf("round trip mismatch: got %+v, want %+v", got, want)
		}
	}
}

func TestClampSumInt32(t *testing.T) {
	tests := []struct {
		name string
		a, b int
		want int32
	}{
		{"normal", 100, 1024, 1124},
		{"negative origin", -1920, 1024, -896},
		{"max int addends saturate (no int64 overflow)", math.MaxInt, math.MaxInt, math.MaxInt32},
		{"min int addends saturate", math.MinInt, math.MinInt, math.MinInt32},
		{"mixed huge saturates", math.MaxInt32, math.MaxInt32, math.MaxInt32},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := clampSumInt32(tt.a, tt.b); got != tt.want {
				t.Errorf("clampSumInt32(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}
