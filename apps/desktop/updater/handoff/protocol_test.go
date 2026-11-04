package handoff

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

type recoveryWorker struct {
	order    *[]string
	budget   time.Duration
	delay    time.Duration
	waitErr  error
	pidKills int
}

func (worker *recoveryWorker) Done() (bool, error) { return false, nil }
func (worker *recoveryWorker) Close() error        { return nil }
func (worker *recoveryWorker) Terminate() error {
	worker.pidKills++
	return nil
}
func (worker *recoveryWorker) Wait(budget time.Duration) (uint32, error) {
	*worker.order = append(*worker.order, "worker-exit")
	worker.budget = budget
	time.Sleep(worker.delay)
	return 0, worker.waitErr
}

type recoveryJob struct {
	order        *[]string
	budget       time.Duration
	terminateErr error
	waitErr      error
	waitResults  []error
}

func (job *recoveryJob) Close() error { return nil }
func (job *recoveryJob) Terminate() error {
	*job.order = append(*job.order, "terminate-job")
	return job.terminateErr
}
func (job *recoveryJob) Wait(budget time.Duration) error {
	*job.order = append(*job.order, "job-empty")
	job.budget = budget
	if len(job.waitResults) > 0 {
		err := job.waitResults[0]
		job.waitResults = job.waitResults[1:]
		return err
	}
	return job.waitErr
}

func TestUpdateDescendantsMustFinishWithoutForcedTermination(test *testing.T) {
	trigger := errors.New("updater descendant exceeded operation deadline")
	for _, scenario := range []struct {
		name     string
		firstErr error
	}{
		{name: "natural-exit"},
		{name: "forced-exit", firstErr: trigger},
	} {
		test.Run(scenario.name, func(test *testing.T) {
			var order []string
			worker := &recoveryWorker{order: &order}
			job := &recoveryJob{order: &order, waitResults: []error{scenario.firstErr, nil}}
			failure := drainUpdate(worker, job, time.Now())
			if scenario.firstErr == nil {
				if failure != nil || fmt.Sprint(order) != "[job-empty]" {
					test.Fatalf("natural completion was interrupted: %v %v", failure, order)
				}
				return
			}
			if failure == nil || !failure.ProcessesExited || !errors.Is(failure, trigger) {
				test.Fatalf("forced descendant exit incorrectly allowed normal restart: %v", failure)
			}
			if fmt.Sprint(order) != "[job-empty terminate-job worker-exit job-empty]" {
				test.Fatalf("unexpected descendant recovery order: %v", order)
			}
		})
	}
}

func TestInterruptedUpdateRequiresBothExitReceipts(test *testing.T) {
	trigger := errors.New("committed worker wait failed")
	termination := errors.New("termination request failed")
	workerFailure := errors.New("worker exit unconfirmed")
	jobFailure := errors.New("job family exit unconfirmed")
	for _, scenario := range []struct {
		name         string
		terminateErr error
		workerErr    error
		jobErr       error
		confirmed    bool
	}{
		{name: "confirmed", confirmed: true},
		{name: "termination-error-but-actually-exited", terminateErr: termination, confirmed: true},
		{name: "worker-unconfirmed", workerErr: workerFailure},
		{name: "descendant-unconfirmed", jobErr: jobFailure},
		{name: "both-unconfirmed", workerErr: workerFailure, jobErr: jobFailure},
	} {
		test.Run(scenario.name, func(test *testing.T) {
			var order []string
			worker := &recoveryWorker{order: &order, waitErr: scenario.workerErr}
			job := &recoveryJob{order: &order, terminateErr: scenario.terminateErr, waitErr: scenario.jobErr}
			failure := interruptUpdate(worker, job, trigger, time.Second)
			if failure.ProcessesExited != scenario.confirmed {
				test.Fatalf("confirmed=%t want=%t", failure.ProcessesExited, scenario.confirmed)
			}
			if got := fmt.Sprint(order); got != "[terminate-job worker-exit job-empty]" {
				test.Fatalf("unsafe cleanup order: %s", got)
			}
			if worker.pidKills != 0 {
				test.Fatal("terminated a worker independently of its owned job")
			}
			for _, cause := range []error{trigger, scenario.terminateErr, scenario.workerErr, scenario.jobErr} {
				if cause != nil && !errors.Is(failure, cause) {
					test.Fatalf("lost failure cause: %v", cause)
				}
			}
			var classified *UpdateRecoveryError
			if !errors.As(fmt.Errorf("coordinate: %w", failure), &classified) || classified != failure {
				test.Fatal("native coordinator cannot classify the recovery failure")
			}
		})
	}
}

func TestInterruptedUpdateSharesOneCleanupDeadline(test *testing.T) {
	const budget = 10 * time.Millisecond
	var order []string
	worker := &recoveryWorker{order: &order, delay: budget * 2}
	job := &recoveryJob{order: &order}
	interruptUpdate(worker, job, errors.New("operation timeout"), budget)
	if worker.budget < 0 || worker.budget > budget {
		test.Fatalf("invalid initial worker budget: %s", worker.budget)
	}
	if job.budget != 0 {
		test.Fatalf("job cleanup reset the exhausted deadline: %s", job.budget)
	}
}

func TestInterruptedUpdateNeverPassesNegativeWait(test *testing.T) {
	var order []string
	worker := &recoveryWorker{order: &order}
	job := &recoveryJob{order: &order}
	interruptUpdate(worker, job, errors.New("operation timeout"), -time.Second)
	if worker.budget != 0 || job.budget != 0 {
		test.Fatalf("negative duration can become an unsigned infinite wait: worker=%s job=%s", worker.budget, job.budget)
	}
}

func TestUpdateRecoveryErrorWithoutCause(test *testing.T) {
	failure := &UpdateRecoveryError{}
	if failure.Error() == "" || failure.Unwrap() != nil {
		test.Fatal("invalid terminal failure without an optional cause")
	}
}
