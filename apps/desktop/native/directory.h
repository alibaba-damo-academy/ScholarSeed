#ifndef SCHOLARSEED_DIRECTORY_H
#define SCHOLARSEED_DIRECTORY_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#ifdef _WIN32
#include <windows.h>
typedef HANDLE file_handle;
#define INVALID_FILE INVALID_HANDLE_VALUE
#else
typedef int file_handle;
#define INVALID_FILE (-1)
#endif

struct directory;
/* PRIVATE denotes product records: Windows access is decided by the OS.
   INSTALLATION retains execution ACL qualification; Darwin PRIVATE is unchanged. */
enum directory_role { DIRECTORY_PRIVATE, DIRECTORY_PROJECT, DIRECTORY_INSTALLATION };
#define DIRECTORY_IDENTITY_BYTES 96
#define DIRECTORY_READ_LIMIT (1024 * 1024)
#define DIRECTORY_RECORD_LIMIT 4096
#define DIRECTORY_NAME_BYTES 128
struct directory_record {
  char name[DIRECTORY_NAME_BYTES + 1];
  unsigned char *data;
  size_t length;
};
struct directory_records {
  struct directory_record *items;
  size_t count;
};
struct directory_error {
  const char *code;
  uint32_t system;
  const char *permission_reason;
  uint32_t permission_mask;
  int permission_index, permission_scope;
};
struct directory_reclamation {
  uint32_t removed;
  bool busy;
  bool retained;
};

/* Existing-only collection, fenced by the permanent identity admission-a.
   ERR_LEASE_RELEASE leaves remaining handles alive until process death. */
bool directory_reclaim(struct directory *directory, const char *identity,
                       struct directory_reclamation *result, struct directory_error *error);

struct directory *directory_open_role(const char *path, bool create, enum directory_role role, struct directory_error *error);
struct directory *directory_open(const char *path, bool create, struct directory_error *error);
struct directory *directory_pin_child(struct directory *parent, const char *name, struct directory_error *error);
file_handle directory_file(struct directory *directory, const char *name, struct directory_error *error);
bool directory_read(struct directory *directory, const char *name, unsigned char *buffer,
                    size_t limit, size_t *length, bool *missing, struct directory_error *error);
/* Caller holds the shared namespace guard against every cooperating mutator.
   This bounded inventory is not an OS snapshot. limit bounds total payload too. */
bool directory_list(struct directory *directory, size_t entries, size_t limit,
                    struct directory_records *records, struct directory_error *error);
void directory_records_free(struct directory_records *records);
bool directory_create(struct directory *directory, const char *name, const unsigned char *buffer,
                      size_t length, struct directory_error *error);
bool directory_child(struct directory *directory, const char *name,
                     char identity[DIRECTORY_IDENTITY_BYTES], struct directory_error *error);
const char *directory_identity(struct directory *directory);
#ifndef _WIN32
/* Cross-boot identity, read from the admitted directory handle, never a path lookup. */
bool directory_persistent_identity(struct directory *directory,
                                   char identity[DIRECTORY_IDENTITY_BYTES],
                                   struct directory_error *error);
#endif
size_t directory_depth(struct directory *directory);
const char *directory_ancestor(struct directory *directory, size_t index);
uint32_t directory_close(struct directory *directory);
#endif
