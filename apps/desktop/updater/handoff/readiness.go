package handoff

import (
	"errors"
	"os"
)

var errPrincipalChanged = errors.New("sandbox principal changed during inspection")

// inspectRuntime has no preparation/worker path. A missing publication may be
// prepared by the caller; invalid existing state fails instead of being repaired.
func (p *Policy) inspectRuntime(r *prepared, timing *componentTimer) (bool, error) {
	if r.admission == nil {
		return false, nil
	}
	done := timing.start(timingAdmission)
	coordinator, err := openProcessWaiter(uint32(os.Getpid()))
	if err != nil {
		return false, err
	}
	p.toolAdmission, err = toolAdmissionFor(coordinator)
	coordinator.Close()
	done()
	if err != nil {
		return false, err
	}
	if p.toolAdmission.principal != r.admission.principal {
		return false, errPrincipalChanged
	}
	for _, component := range r.runtime.Components {
		timer := p.timer(component, timingReadiness)
		ready, checkErr := checkReadiness(*p, r.request.Root, component, timer)
		if ready {
			timer.event.Status = "reused"
		}
		timer.finish(&checkErr)
		if checkErr != nil {
			return false, checkErr
		}
		if !ready {
			return false, nil
		}
	}
	done = timing.start(timingTools)
	defer done()
	return p.applicationToolsReady(r.request.Root, r.runtime, p.PackVersion)
}
