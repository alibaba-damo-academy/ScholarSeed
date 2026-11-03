package handoff

import "time"

const progressInterval = 100 * time.Millisecond

// ComponentProgress is display-only. Completion and trust still require receipts.
type ComponentProgress struct {
	Kind       string `json:"kind"`
	Phase      string `json:"phase"`
	Files      int    `json:"files"`
	TotalFiles int    `json:"totalFiles"`
	Bytes      int64  `json:"bytes"`
	TotalBytes int64  `json:"totalBytes"`
}

func (p Policy) componentProgress(c Component) func(string, int, int64) {
	var reported time.Time
	var previous string
	return func(phase string, files int, bytes int64) {
		if p.observeProgress == nil {
			return
		}
		if phase == previous && files != len(c.Files) && time.Since(reported) < progressInterval {
			return
		}
		previous, reported = phase, time.Now()
		p.observeProgress(ComponentProgress{c.Kind, phase, files, len(c.Files), bytes, c.ExpandedBytes})
	}
}
