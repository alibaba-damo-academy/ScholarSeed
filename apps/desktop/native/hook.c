// Electron's documented Windows delay-load route resolves N-API exports from
// the running host image, never a node.exe found through PATH or the filesystem.
#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI host_library(unsigned int event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return (FARPROC)GetModuleHandleW(NULL);
  return NULL;
}

PfnDliHook __pfnDliNotifyHook2 = host_library;
