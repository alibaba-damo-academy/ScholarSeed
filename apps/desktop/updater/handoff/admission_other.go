//go:build !windows

package handoff

import "os"

func (*toolAdmission) prepare(*os.File) error                { return errWindows }
func toolRootIdentity(string) (string, error)                { return "", errWindows }
func toolStageIdentity(*os.File) (string, error)             { return "", errWindows }
func resolveToolPrincipal() (string, error)                  { return "", errWindows }
func toolPrincipalMissing(error) bool                        { return false }
func ensureToolPrincipal() (string, error)                   { return "", errWindows }
func toolAdmissionFor(processWaiter) (*toolAdmission, error) { return nil, errWindows }
