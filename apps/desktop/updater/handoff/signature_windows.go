package handoff

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	trustNoUI             = 2
	trustFileChoice       = 1
	trustCatalogChoice    = 2
	trustVerify           = 1
	trustClose            = 2
	certificateRDNName    = 2
	certificateX500Name   = 0x02000003
	maximumPublisherUnits = 16384
	maximumCatalogHash    = 64
	catalogPathUnits      = 260
	systemDirectoryUnits  = 32768
	searchSystemDirectory = 0x00000800
)

var authenticodeAction = syscall.GUID{Data1: 0x00aac56b, Data2: 0xcd44, Data3: 0x11d0, Data4: [8]byte{0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee}}

type trustFile struct {
	Size    uint32
	Path    *uint16
	Handle  syscall.Handle
	Subject unsafe.Pointer
}

type trustCatalog struct {
	Size       uint32
	Version    uint32
	Path       *uint16
	MemberTag  *uint16
	MemberPath *uint16
	MemberFile syscall.Handle
	Hash       *byte
	HashBytes  uint32
	Context    unsafe.Pointer
	Admin      syscall.Handle
}

type trustData struct {
	Size              uint32
	PolicyCallback    unsafe.Pointer
	SIPClient         unsafe.Pointer
	UIChoice          uint32
	RevocationChecks  uint32
	UnionChoice       uint32
	Choice            unsafe.Pointer
	StateAction       uint32
	State             syscall.Handle
	URLReference      *uint16
	ProviderFlags     uint32
	UIContext         uint32
	SignatureSettings unsafe.Pointer
}

type catalogInformation struct {
	Size uint32
	Path [catalogPathUnits]uint16
}

type providerCertificate struct {
	Size        uint32
	Certificate uintptr
}

func signaturePublisher(actual, expected string) error {
	if actual == "" || expected == "" || actual != expected {
		return errors.New("executable publisher differs")
	}
	return nil
}

func signatureLibrary(name string) (*syscall.DLL, error) {
	var buffer [systemDirectoryUnits]uint16
	length, _, callErr := kernel.NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if length == 0 || length >= uintptr(len(buffer)) {
		return nil, fmt.Errorf("signature system directory unavailable: %w", callErr)
	}
	filename := filepath.Join(syscall.UTF16ToString(buffer[:length]), name)
	path, err := syscall.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	handle, _, callErr := kernel.NewProc("LoadLibraryExW").Call(uintptr(unsafe.Pointer(path)), 0, searchSystemDirectory)
	if handle == 0 {
		return nil, fmt.Errorf("signature system library unavailable: %w", callErr)
	}
	return &syscall.DLL{Name: filename, Handle: syscall.Handle(handle)}, nil
}

func nativeSignature(file *os.File) (string, error) {
	if file == nil {
		return "", errors.New("signature input is absent")
	}
	trust, err := signatureLibrary("wintrust.dll")
	if err != nil {
		return "", err
	}
	defer trust.Release()
	crypto, err := signatureLibrary("crypt32.dll")
	if err != nil {
		return "", err
	}
	defer crypto.Release()
	filename, err := syscall.UTF16PtrFromString(file.Name())
	if err != nil {
		return "", err
	}
	var catalogErrors error
	for _, algorithm := range []string{"SHA256", "SHA1"} {
		subject, found, catalogErr := catalogSignature(trust, crypto, file, filename, algorithm)
		if catalogErr != nil {
			catalogErrors = errors.Join(catalogErrors, catalogErr)
			continue
		}
		if found {
			return subject, nil
		}
	}
	information := trustFile{Path: filename, Handle: syscall.Handle(file.Fd())}
	information.Size = uint32(unsafe.Sizeof(information))
	subject, err := verifySignature(trust, crypto, trustFileChoice, unsafe.Pointer(&information))
	runtime.KeepAlive(file)
	runtime.KeepAlive(filename)
	if err != nil {
		return "", errors.Join(catalogErrors, err)
	}
	return subject, err
}

func verifySignature(trust, crypto *syscall.DLL, choice uint32, information unsafe.Pointer) (subject string, err error) {
	verify, err := trust.FindProc("WinVerifyTrust")
	if err != nil {
		return "", err
	}
	data := trustData{UIChoice: trustNoUI, UnionChoice: choice, Choice: information, StateAction: trustVerify}
	data.Size = uint32(unsafe.Sizeof(data))
	status, _, _ := verify.Call(0, uintptr(unsafe.Pointer(&authenticodeAction)), uintptr(unsafe.Pointer(&data)))
	defer func() {
		data.StateAction = trustClose
		closed, _, _ := verify.Call(0, uintptr(unsafe.Pointer(&authenticodeAction)), uintptr(unsafe.Pointer(&data)))
		if closed != 0 {
			subject = ""
			err = errors.Join(err, fmt.Errorf("signature state release failed: 0x%08x", uint32(closed)))
		}
	}()
	if uint32(status) != 0 {
		return "", fmt.Errorf("Authenticode trust verification failed: 0x%08x", uint32(status))
	}
	provider, err := trust.FindProc("WTHelperProvDataFromStateData")
	if err != nil {
		return "", err
	}
	signer, err := trust.FindProc("WTHelperGetProvSignerFromChain")
	if err != nil {
		return "", err
	}
	certificate, err := trust.FindProc("WTHelperGetProvCertFromChain")
	if err != nil {
		return "", err
	}
	providerData, _, _ := provider.Call(uintptr(data.State))
	if providerData == 0 {
		return "", errors.New("signature provider state is absent")
	}
	providerSigner, _, _ := signer.Call(providerData, 0, 0, 0)
	if providerSigner == 0 {
		return "", errors.New("verified signature signer is absent")
	}
	providerCert, _, _ := certificate.Call(providerSigner, 0)
	if providerCert == 0 {
		return "", errors.New("verified signer certificate is absent")
	}
	context, err := verifiedCertificate(providerCert)
	if err != nil {
		return "", err
	}
	if context == 0 {
		return "", errors.New("verified certificate context is absent")
	}
	name, err := crypto.FindProc("CertGetNameStringW")
	if err != nil {
		return "", err
	}
	format := uint32(certificateX500Name)
	length, _, _ := name.Call(context, certificateRDNName, 0, uintptr(unsafe.Pointer(&format)), 0, 0)
	if length <= 1 || length > maximumPublisherUnits {
		return "", errors.New("verified publisher name is invalid")
	}
	buffer := make([]uint16, length)
	written, _, _ := name.Call(context, certificateRDNName, 0, uintptr(unsafe.Pointer(&format)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if written != length {
		return "", errors.New("verified publisher name changed")
	}
	return syscall.UTF16ToString(buffer), nil
}

func verifiedCertificate(address uintptr) (uintptr, error) {
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	var information providerCertificate
	var read uintptr
	ok, _, callErr := kernel.NewProc("ReadProcessMemory").Call(uintptr(process), address, uintptr(unsafe.Pointer(&information)), unsafe.Sizeof(information), uintptr(unsafe.Pointer(&read)))
	if ok == 0 || read != unsafe.Sizeof(information) || uintptr(information.Size) < unsafe.Sizeof(information) {
		return 0, fmt.Errorf("verified certificate state is unreadable: %w", callErr)
	}
	return information.Certificate, nil
}

func catalogSignature(trust, crypto *syscall.DLL, file *os.File, filename *uint16, algorithm string) (string, bool, error) {
	acquire, err := trust.FindProc("CryptCATAdminAcquireContext2")
	if err != nil {
		return "", false, err
	}
	release, err := trust.FindProc("CryptCATAdminReleaseContext")
	if err != nil {
		return "", false, err
	}
	calculate, err := trust.FindProc("CryptCATAdminCalcHashFromFileHandle2")
	if err != nil {
		return "", false, err
	}
	enumerate, err := trust.FindProc("CryptCATAdminEnumCatalogFromHash")
	if err != nil {
		return "", false, err
	}
	information, err := trust.FindProc("CryptCATCatalogInfoFromContext")
	if err != nil {
		return "", false, err
	}
	releaseCatalog, err := trust.FindProc("CryptCATAdminReleaseCatalogContext")
	if err != nil {
		return "", false, err
	}
	algorithmName, err := syscall.UTF16PtrFromString(algorithm)
	if err != nil {
		return "", false, err
	}
	var administrator syscall.Handle
	ok, _, callErr := acquire.Call(uintptr(unsafe.Pointer(&administrator)), 0, uintptr(unsafe.Pointer(algorithmName)), 0, 0)
	if ok == 0 {
		return "", false, fmt.Errorf("catalog administrator unavailable: %w", callErr)
	}
	defer release.Call(uintptr(administrator), 0)
	if _, err := file.Seek(0, 0); err != nil {
		return "", false, err
	}
	var hashBytes uint32
	ok, _, callErr = calculate.Call(uintptr(administrator), file.Fd(), uintptr(unsafe.Pointer(&hashBytes)), 0, 0)
	if hashBytes == 0 || hashBytes > maximumCatalogHash {
		return "", false, fmt.Errorf("catalog hash size unavailable: %w", callErr)
	}
	hash := make([]byte, hashBytes)
	if _, err := file.Seek(0, 0); err != nil {
		return "", false, err
	}
	ok, _, callErr = calculate.Call(uintptr(administrator), file.Fd(), uintptr(unsafe.Pointer(&hashBytes)), uintptr(unsafe.Pointer(&hash[0])), 0)
	if ok == 0 || hashBytes != uint32(len(hash)) {
		return "", false, fmt.Errorf("catalog hash unavailable: %w", callErr)
	}
	catalog, _, _ := enumerate.Call(uintptr(administrator), uintptr(unsafe.Pointer(&hash[0])), uintptr(len(hash)), 0, 0)
	if catalog == 0 {
		return "", false, nil
	}
	defer releaseCatalog.Call(uintptr(administrator), catalog, 0)
	info := catalogInformation{}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, callErr = information.Call(catalog, uintptr(unsafe.Pointer(&info)), 0)
	if ok == 0 {
		return "", false, fmt.Errorf("catalog identity unavailable: %w", callErr)
	}
	tag, err := syscall.UTF16PtrFromString(strings.ToUpper(hex.EncodeToString(hash)))
	if err != nil {
		return "", false, err
	}
	data := trustCatalog{Path: &info.Path[0], MemberTag: tag, MemberPath: filename, MemberFile: syscall.Handle(file.Fd()), Hash: &hash[0], HashBytes: uint32(len(hash)), Admin: administrator}
	data.Size = uint32(unsafe.Sizeof(data))
	subject, err := verifySignature(trust, crypto, trustCatalogChoice, unsafe.Pointer(&data))
	runtime.KeepAlive(hash)
	runtime.KeepAlive(tag)
	runtime.KeepAlive(file)
	if err != nil {
		return "", false, err
	}
	return subject, true, nil
}
