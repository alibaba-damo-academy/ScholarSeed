#ifndef SCHOLARSEED_DARWIN_PERMISSIONS_H
#define SCHOLARSEED_DARWIN_PERMISSIONS_H
#include <stdbool.h>
#include <sys/stat.h>
#include <sys/types.h>

// macOS Data-volume roots are normally root:admin (gid 80), mode 0775.
// Admin is a privileged OS group; this exception applies only to ancestors.
// Leaves, ordinary groups, world-write and extended ACLs remain restricted.
static inline bool darwin_directory_mode_trusted(uid_t owner, gid_t group,
                                                mode_t mode, bool ancestor,
                                                uid_t current) {
  if (owner != 0 && owner != current) return false;
  if (!(mode & (S_IWGRP | S_IWOTH))) return true;
  if (ancestor && (mode & S_ISVTX)) return true;
  return ancestor && owner == 0 && group == 80 && !(mode & S_IWOTH);
}
#endif
