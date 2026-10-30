#include <stdio.h>
#include "notification.h"

int main(void) {
  const struct {
    const char *name;
    int32_t result;
    int32_t setting;
    enum notification_permission expected;
  } cases[] = {
    {"enabled", 0, 0, NOTIFICATION_PERMISSION_ENABLED},
    {"disabled for application", 0, 1, NOTIFICATION_PERMISSION_DISABLED},
    {"disabled for user", 0, 2, NOTIFICATION_PERMISSION_DISABLED},
    {"disabled by policy", 0, 3, NOTIFICATION_PERMISSION_DISABLED},
    {"disabled by manifest", 0, 4, NOTIFICATION_PERMISSION_DISABLED},
    {"future setting", 0, 5, NOTIFICATION_PERMISSION_DISABLED},
    {"invalid setting", 0, -1, NOTIFICATION_PERMISSION_DISABLED},
    {"first notification", NOTIFICATION_SETTING_MISSING_HRESULT, -1, NOTIFICATION_PERMISSION_UNAVAILABLE},
    {"failed query overwrites output", NOTIFICATION_SETTING_MISSING_HRESULT, 0, NOTIFICATION_PERMISSION_UNAVAILABLE},
    {"failed query output is not authoritative", NOTIFICATION_SETTING_MISSING_HRESULT, 1, NOTIFICATION_PERMISSION_UNAVAILABLE},
    {"access denied", (int32_t)0x80070005u, 0, NOTIFICATION_PERMISSION_ERROR},
    {"invalid argument", (int32_t)0x80070057u, 0, NOTIFICATION_PERMISSION_ERROR},
    {"generic failure", (int32_t)0x80004005u, 0, NOTIFICATION_PERMISSION_ERROR},
    {"unsupported interface", (int32_t)0x80004002u, 0, NOTIFICATION_PERMISSION_ERROR},
    {"RPC unavailable", (int32_t)0x800706bau, 0, NOTIFICATION_PERMISSION_ERROR},
  };
  for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
    enum notification_permission actual = notification_permission(cases[index].result, cases[index].setting);
    if (actual != cases[index].expected) {
      fprintf(stderr, "%s: expected %d, got %d\n", cases[index].name, cases[index].expected, actual);
      return 1;
    }
  }
  puts("notification permission contracts passed");
  return 0;
}
