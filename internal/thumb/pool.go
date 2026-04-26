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
