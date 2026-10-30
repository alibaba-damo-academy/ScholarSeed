package handoff

const (
	toolAccessPolicy = 1
	toolUsersGroup   = "CodexSandboxUsers"
)

type toolAdmission struct {
	principal string
	owner     string
}

func (p Policy) admitsComponent(kind string) bool {
	return p.toolAdmission != nil && (kind == "python" || kind == "texlive" || kind == "powershell")
}
