package imgfile

import "testing"

func TestIsImage(t *testing.T) {
	cases := map[string]bool{
		"a.jpg":     true,
		"a.JPG":     true,
		"a.jpeg":    true,
		"a.png":     true,
		"a.gif":     true,
		"a.WebP":    true,
		"a.avif":    true,
		"a.AVIF":    true,
		"a.bmp":     false,
		"a.txt":     false,
		"noext":     false,
		".hidden":   false,
		".hidden.j": false,
	}
	for name, want := range cases {
		if got := IsImage(name); got != want {
			t.Errorf("IsImage(%q) = %v, want %v", name, got, want)
		}
	}
}
