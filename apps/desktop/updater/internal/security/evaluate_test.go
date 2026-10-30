package security

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedACLOracle(t *testing.T) {
	data, err := os.ReadFile("../../../native/security.test.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name      string
		Role      int
		Execution bool
		Entries   []Entry
		Expected  Result
		Owner     *struct {
			Trusted bool
			Allowed bool
		}
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			if v.Owner != nil && Owner(v.Role, v.Owner.Trusted) != v.Owner.Allowed {
				t.Fatal("owner decision differs from shared oracle")
			}
			if got := Evaluate(v.Entries, v.Role, v.Execution); got != v.Expected {
				t.Fatalf("got=%+v want=%+v", got, v.Expected)
			}
		})
	}
}

// Authority expectations are shared with the C and Python consumers, separately
// from generated policy inputs so accidental trust expansion is observable.
func TestSharedPrincipalOracle(t *testing.T) {
	data, err := os.ReadFile("../../../native/principals.test.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name, Principal, User string
		Trusted               bool
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			if Authority(vector.Principal, vector.User) != vector.Trusted {
				t.Fatal("authority differs from shared oracle")
			}
		})
	}
}

func TestNamedProfileMatrix(t *testing.T) {
	data, err := os.ReadFile("../../../native/profiles.test.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Profile, Principal, User, Executor, Owner string
		AdministratorMember                       bool `json:"administrator_member"`
		Trusted                                   bool
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	for i, row := range rows {
		var got bool
		switch row.Profile {
		case "machine_authority":
			got = MachineAuthority(row.Principal)
		case "tool_owner":
			got = ToolOwner(row.Principal, row.User, row.Executor)
		case "tool_writer":
			got = ToolWriter(row.Principal, row.User, row.Owner)
		case "recovery_owner":
			got = RecoveryOwner(row.Principal, row.User)
		case "recovery_writer":
			got = RecoveryWriter(row.Principal, row.User, row.Owner)
		case "private_owner":
			got = PrivateOwner(row.Principal, row.User, row.AdministratorMember)
		case "private_writer":
			got = PrivateWriter(row.Principal, row.User)
		case "lease_state":
			got = LeaseState(row.Principal, row.User)
		case "lease_grant":
			got = LeaseGrant(row.Principal, row.User)
		default:
			t.Fatal("unrecognized matrix profile")
		}
		if got != row.Trusted {
			t.Fatalf("row %d profile=%s got %v", i, row.Profile, got)
		}
	}
}
