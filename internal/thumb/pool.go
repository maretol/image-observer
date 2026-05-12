package thumb

import "sync"

type job struct {
	done chan struct{}
	data []byte
	err  error
}

type pool struct {
	sem      chan struct{}
	inflight sync.Map // key string -> *job
}

var defaultPool = newPool(defaultWorkerCount())

func newPool(maxConcurrent int) *pool {
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	return &pool{sem: make(chan struct{}, maxConcurrent)}
}

// InitWorkerPool replaces the package-level worker pool. Intended to be
// called once at startup from main.go after settings have loaded — passing
// 0 (or any value <1) keeps the default `runtime.NumCPU()/2` heuristic.
//
// A note on safety: this is NOT safe to call after thumbnails have started
// being served (it would orphan in-flight callers waiting on the previous
// pool's semaphore). The caller (main.go) only invokes it during startup
// before the Wails runtime exposes GetThumbnail to the frontend, so the
// settings UI flags worker-count changes as restart-required.
func InitWorkerPool(maxConcurrent int) {
	if maxConcurrent < 1 {
		maxConcurrent = defaultWorkerCount()
	}
	defaultPool = newPool(maxConcurrent)
}

// CurrentWorkerCount reports the active pool's concurrency cap. Tests use
// this to verify InitWorkerPool took effect.
func CurrentWorkerCount() int {
	return cap(defaultPool.sem)
}

// Generate runs fn, deduplicating concurrent calls with the same key.
// The first caller for a key executes fn under the semaphore; followers wait
// on the same job and receive the shared result.
func (p *pool) Generate(key string, fn func() ([]byte, error)) ([]byte, error) {
	newJob := &job{done: make(chan struct{})}
	if existing, loaded := p.inflight.LoadOrStore(key, newJob); loaded {
		j := existing.(*job)
		<-j.done
		return j.data, j.err
	}

	defer func() {
		close(newJob.done)
		p.inflight.Delete(key)
	}()

	p.sem <- struct{}{}
	defer func() { <-p.sem }()

	newJob.data, newJob.err = fn()
	return newJob.data, newJob.err
}
