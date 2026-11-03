package handoff

import (
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"
)

func TestNativeSignatureRejectsUnsignedFile(test *testing.T) {
	filename := filepath.Join(test.TempDir(), "unsigned.exe")
	if err := os.WriteFile(filename, []byte("not a signed executable"), 0600); err != nil {
		test.Fatal(err)
	}
	file, err := pinFile(filename)
	if err != nil {
		test.Fatal(err)
	}
	defer file.Close()
	if _, err := nativeSignature(file); err == nil {
		test.Fatal("unsigned input was trusted")
	}
}

func TestNativeSignatureRejectsMissingSigner(test *testing.T) {
	for _, subject := range []string{"", "other publisher"} {
		if err := signaturePublisher(subject, "expected publisher"); err == nil {
			test.Fatalf("accepted publisher %q", subject)
		}
	}
	if err := signaturePublisher("expected publisher", "expected publisher"); err != nil {
		test.Fatal(err)
	}
	if err := signaturePublisher("Expected publisher", "expected publisher"); err == nil {
		test.Fatal("publisher comparison became case insensitive")
	}
}

func TestNativeSignatureFixture(test *testing.T) {
	filename := os.Getenv("SCHOLARSEED_SIGNATURE_TEST_FILE")
	publisher := os.Getenv("SCHOLARSEED_SIGNATURE_TEST_PUBLISHER")
	if filename == "" && publisher == "" {
		test.Skip("explicit signed native fixture was not selected")
	}
	if filename == "" || publisher == "" {
		test.Fatal("signed fixture requires both file and publisher")
	}
	file, err := pinFile(filename)
	if err != nil {
		test.Fatal(err)
	}
	defer file.Close()
	started := time.Now()
	subject, err := nativeSignature(file)
	if err != nil {
		test.Fatal(err)
	}
	if subject != publisher {
		test.Fatalf("native publisher %q differs from oracle %q", subject, publisher)
	}
	test.Logf("native trust and publisher extraction: %s", time.Since(started))
	if err := verifyAuthenticodeFiles([]string{filename}, Signing{Mode: "authenticode", Publisher: publisher}); err != nil {
		test.Fatal(err)
	}
	if err := verifyAuthenticodeFiles([]string{filename}, Signing{Mode: "authenticode", Publisher: "not the expected publisher"}); err == nil {
		test.Fatal("unexpected publisher was trusted")
	}
}

func TestNativeSignatureRejectsFixture(test *testing.T) {
	filename := os.Getenv("SCHOLARSEED_SIGNATURE_TEST_REJECT")
	if filename == "" {
		test.Skip("explicit invalid native fixture was not selected")
	}
	file, err := pinFile(filename)
	if err != nil {
		test.Fatal(err)
	}
	defer file.Close()
	if _, err = nativeSignature(file); err == nil {
		test.Fatal("invalid signature was trusted")
	}
	if err = verifyAuthenticodeFiles([]string{filename}, Signing{Mode: "authenticode", Publisher: "any publisher"}); err == nil {
		test.Fatal("invalid executable was trusted")
	}
}

func TestNativeSignatureStructureLayout(test *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		test.Fatal("signature ABI requires a supported 64-bit Windows target")
	}
	for name, actual := range map[string]uintptr{
		"file":                unsafe.Sizeof(trustFile{}),
		"catalog":             unsafe.Sizeof(trustCatalog{}),
		"data":                unsafe.Sizeof(trustData{}),
		"certificate":         unsafe.Sizeof(providerCertificate{}),
		"catalog information": unsafe.Sizeof(catalogInformation{}),
	} {
		expected := map[string]uintptr{"file": 32, "catalog": 72, "data": 88, "certificate": 16, "catalog information": 524}[name]
		if actual != expected {
			test.Fatalf("%s ABI size %d differs from %d", name, actual, expected)
		}
	}
}

func TestNativeSignatureRejectsUnreadableProvider(test *testing.T) {
	if _, err := verifiedCertificate(0); err == nil {
		test.Fatal("invalid provider memory was accepted")
	}
}

func TestNativeSignaturePinsInputAgainstMutation(test *testing.T) {
	filename := filepath.Join(test.TempDir(), "pinned.exe")
	if err := os.WriteFile(filename, []byte("temporary native fixture"), 0600); err != nil {
		test.Fatal(err)
	}
	file, err := pinFile(filename)
	if err != nil {
		test.Fatal(err)
	}
	defer file.Close()
	if writable, err := os.OpenFile(filename, os.O_WRONLY, 0); err == nil {
		writable.Close()
		test.Fatal("pinned trust input remained writable")
	}
	if err := os.Rename(filename, filename+".moved"); err == nil {
		test.Fatal("pinned trust input could be replaced")
	}
}

func TestNativeSignatureRejectsLinkedInput(test *testing.T) {
	root := test.TempDir()
	filename := filepath.Join(root, "linked.exe")
	if err := os.WriteFile(filename, []byte("temporary native fixture"), 0600); err != nil {
		test.Fatal(err)
	}
	if err := os.Link(filename, filepath.Join(root, "alias.exe")); err != nil {
		test.Fatal(err)
	}
	if err := verifyAuthenticodeFiles([]string{filename}, Signing{Mode: "authenticode", Publisher: "any publisher"}); err == nil {
		test.Fatal("linked trust input was accepted")
	}
}
