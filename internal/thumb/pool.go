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

// InitWorkerPool は worker pool を差し替える。main.go が起動時 1 回だけ呼ぶ (0/<1 は既定 NumCPU()/2)。
// サムネ提供開始後に呼ぶのは unsafe (in-flight caller を orphan にする) ため settings UI は worker 数変更を
// 再起動必須にする。
func InitWorkerPool(maxConcurrent int) {
	if maxConcurrent < 1 {
		maxConcurrent = defaultWorkerCount()
	}
	defaultPool = newPool(maxConcurrent)
}

// CurrentWorkerCount は active pool の並行上限を返す。
func CurrentWorkerCount() int {
	return cap(defaultPool.sem)
}

// Generate は fn を実行し、同じ key の並行呼び出しを dedup する (最初の caller が実行、後続は結果を共有)。
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
