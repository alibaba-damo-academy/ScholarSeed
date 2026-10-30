// Generated from security.json; schema=2 sha256=315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4
#ifndef SCHOLARSEED_SECURITY_H
#define SCHOLARSEED_SECURITY_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#define SC_POLICY_HASH "315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4"
#define SC_DIAGNOSTIC_SCHEMA 1
#define SC_DIAGNOSTIC_EVENT "permission_rejected"
struct sc_entry { uint32_t principal; uint32_t mask; uint32_t flags; bool deny; bool trusted; bool universal; bool allow_subject; bool deny_subject; };
struct sc_result { int reason; int index; uint32_t mask; int scope; };
#define SC_ROLE_CONTENT 0
#define SC_ROLE_ANCESTOR 1
#define SC_ROLE_VOLUME 2
#define SC_ROLE_RUNTIME 3

static const unsigned char sc_authority_0[] = {1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0};
static const unsigned char sc_authority_1[] = {1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0};
static const unsigned char sc_authority_2[] = {1, 6, 0, 0, 0, 0, 0, 5, 80, 0, 0, 0, 181, 137, 251, 56, 25, 132, 194, 203, 92, 108, 35, 109, 87, 0, 119, 110, 192, 2, 100, 135};
static inline bool sc_authority(const void *principal, size_t principal_len, const void *user, size_t user_len) {
    if (!principal || !principal_len) return false;
    if (user && principal_len == user_len && !memcmp(principal, user, user_len)) return true;
    if (principal_len == sizeof(sc_authority_0) && !memcmp(principal, sc_authority_0, principal_len)) return true;
    if (principal_len == sizeof(sc_authority_1) && !memcmp(principal, sc_authority_1, principal_len)) return true;
    if (principal_len == sizeof(sc_authority_2) && !memcmp(principal, sc_authority_2, principal_len)) return true;
    return false;
}

static inline const char *sc_diagnostic_subject(const char *reason) { if (!strcmp(reason, "untrusted_owner")) return "owner"; if (!strcmp(reason, "foreign_writer")) return "writer"; if (!strcmp(reason, "execution_denied")) return "execution_token"; return "unknown"; }
static inline const char *sc_diagnostic_system_reason(uint32_t code) { switch(code) { case 5: return "os_access_denied"; case 1223: return "authorization_cancelled"; case 1300: return "privilege_not_held"; case 1314: return "privilege_not_held"; } return NULL; }
static inline bool sc_owner(int role, bool trusted) {
    return (trusted || (role == 2));
}

static inline uint32_t sc_mask(uint32_t mask) {
    if ((mask & 2147483648) != 0) {
        mask = ((mask & (~(uint32_t)(2147483648))) | 1179785);
    }
    if ((mask & 1073741824) != 0) {
        mask = ((mask & (~(uint32_t)(1073741824))) | 1179926);
    }
    if ((mask & 536870912) != 0) {
        mask = ((mask & (~(uint32_t)(536870912))) | 1179808);
    }
    if ((mask & 268435456) != 0) {
        mask = ((mask & (~(uint32_t)(268435456))) | 2032127);
    }
    return mask;
}

static inline uint32_t sc_allowed(int role) {
    uint32_t value = 1179817;
    if ((role == 1) || (role == 2)) {
        value = (value | 6);
    }
    if (role == 2) {
        value = (value | 852240);
    }
    return value;
}

static inline bool sc_applies(uint32_t flags, int role, int scope) {
    if (scope == 0) {
        return ((flags & 8) == 0);
    }
    if (role != 3) {
        return false;
    }
    if ((scope >= 3) && ((flags & 4) != 0)) {
        return false;
    }
    if ((scope == 1) || (scope == 3)) {
        return ((flags & 1) != 0);
    }
    return ((flags & 2) != 0);
}

static inline uint32_t sc_danger(const struct sc_entry *entries, int entries_len, int role, int index, int scope) {
    (void)entries_len;
    if ((entries[index].deny || entries[index].trusted) || (!sc_applies(entries[index].flags, role, scope))) {
        return 0;
    }
    uint32_t denied = 0;
    for (int j = 0; j < index; j++) {
        if ((entries[j].deny && ((entries[j].principal == entries[index].principal) || entries[j].universal)) && sc_applies(entries[j].flags, role, scope)) {
            denied = (denied | sc_mask(entries[j].mask));
        }
    }
    return ((sc_mask(entries[index].mask) & (~(uint32_t)(sc_allowed(role)))) & (~(uint32_t)(denied)));
}

static inline uint32_t sc_blocked(const struct sc_entry *entries, int entries_len, int index, int scope) {
    (void)entries_len;
    if (!(entries[index].deny && entries[index].deny_subject)) {
        return 0;
    }
    uint32_t granted = 0;
    for (int j = 0; j < index; j++) {
        if (((!entries[j].deny) && entries[j].allow_subject) && sc_applies(entries[j].flags, 3, scope)) {
            granted = (granted | sc_mask(entries[j].mask));
        }
    }
    return ((sc_mask(entries[index].mask) & 1179817) & (~(uint32_t)(granted)));
}

static inline struct sc_result sc_evaluate(const struct sc_entry *entries, int entries_len, int role, bool execution) {
    (void)entries_len;
    for (int i = 0; i < entries_len; i++) {
        for (int scope = 0; scope < 5; scope++) {
            uint32_t dangerous = sc_danger(entries, entries_len, role, i, scope);
            if (dangerous != 0) {
                return (struct sc_result){1, i, dangerous, scope};
            }
            if (execution && sc_applies(entries[i].flags, role, scope)) {
                uint32_t denied = sc_blocked(entries, entries_len, i, scope);
                if (denied != 0) {
                    return (struct sc_result){2, i, denied, scope};
                }
            }
        }
    }
    return (struct sc_result){0, -1, 0, 0};
}
#endif
