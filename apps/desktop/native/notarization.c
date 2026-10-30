// Offline verification of the exact attached Apple ticket, never the system ticket cache.
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

#define TICKET_LIMIT (1024 * 1024)
#define TICKET_HEADER 16
#define CONTENT_HEADER 24
#define HASH_LENGTH 20
#define HASH_ENTRY (HASH_LENGTH + 1)
#define SIGNATURE_LENGTH 72
#define CERTIFICATE_COUNT 2
#define MAX_ARCHITECTURES 8
#define PATH_LIMIT 8192
#define TICKET_MAGIC 0x68633873u
#define CONTENT_MAGIC 0x6b743867u
#define TICKET_VERSION 1u
#define SHA256_ALGORITHM 2u
// Security's Apple policy pins the root, chain length and both ticket-only markers.
// Unsupported policy IDs fail closed. No private functions or ticket-cache APIs are used.
#define TICKET_POLICY CFSTR("1.2.840.113635.100.1.90")
#define UNTRUSTED "ERR_NOTARIZATION_UNTRUSTED"
#define UNAVAILABLE "ERR_NOTARIZATION_UNAVAILABLE"

struct verification {
  napi_async_work work;
  napi_deferred deferred;
  uint8_t *bytes;
  char *application;
  size_t length;
  uint8_t hashes[MAX_ARCHITECTURES][HASH_LENGTH];
  size_t hash_count;
  const char *error;
  const char *code;
};

static uint32_t le32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
    ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// A bounded, canonical DER SEQUENCE envelope. Security parses certificate contents.
static bool sequence(const uint8_t *bytes, size_t available, size_t *header, size_t *length) {
  if (available < 2 || bytes[0] != 0x30) return false;
  size_t count = bytes[1], value = count;
  *header = 2;
  if (count & 0x80) {
    count &= 0x7f;
    if (!count || count > sizeof(uint32_t) || count > available - 2 || !bytes[2]) return false;
    value = 0;
    for (size_t i = 0; i < count; i++) value = (value << 8) | bytes[2 + i];
    if (value < 128) return false;
    *header += count;
  }
  if (value > available - *header) return false;
  *length = value + *header;
  return true;
}

static void execute(napi_env env, void *data) {
  (void)env;
  struct verification *v = data;
  v->code = UNTRUSTED;
  if (v->application) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)v->application,
      (CFIndex)strlen(v->application), true);
    SecStaticCodeRef code = NULL;
    v->error = "Application signature verification failed";
    if (!url || SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) != errSecSuccess) {
      if (url) CFRelease(url);
      return;
    }
    SecCSFlags flags = kSecCSCheckAllArchitectures | kSecCSCheckNestedCode |
      kSecCSStrictValidate | kSecCSNoNetworkAccess;
    if (SecStaticCodeCheckValidity(code, flags, NULL) == errSecSuccess) v->error = NULL;
    CFRelease(code);
    CFRelease(url);
    return;
  }
  v->error = "Malformed or unsupported Apple notarization ticket";
  const uint8_t *b = v->bytes;
  if (v->length < TICKET_HEADER + CONTENT_HEADER + SIGNATURE_LENGTH ||
      le32(b) != TICKET_MAGIC || le32(b + 4) != TICKET_VERSION) return;
  size_t certificates_length = le32(b + 8), content_length = le32(b + 12);
  if (certificates_length > v->length - TICKET_HEADER ||
      content_length < CONTENT_HEADER ||
      content_length > v->length - TICKET_HEADER - certificates_length ||
      v->length - TICKET_HEADER - certificates_length - content_length != SIGNATURE_LENGTH) return;
  const size_t content_offset = TICKET_HEADER + certificates_length;
  const size_t signature_offset = content_offset + content_length;
  const uint8_t *content = b + content_offset;
  if (le32(content) != CONTENT_MAGIC || content[4] != SHA256_ALGORITHM || content[5] != 0 ||
      content[6] != HASH_LENGTH || content[7] != 0 || le32(content + 12) != 0) return;
  size_t count = le32(content + 8);
  if (!count || count > (TICKET_LIMIT / HASH_ENTRY) ||
      content_length != CONTENT_HEADER + count * HASH_ENTRY) return;
  // Unknown per-entry algorithms are not silently treated as SHA-256. SHA-1 may
  // identify a package in a submission, but cannot authorize a target executable.
  for (size_t i = 0; i < count; i++) {
    uint8_t algorithm = content[CONTENT_HEADER + i * HASH_ENTRY];
    if (algorithm != 1 && algorithm != SHA256_ALGORITHM) return;
  }
  for (size_t h = 0; h < v->hash_count; h++) {
    bool found = false;
    for (size_t i = 0; i < count; i++) {
      const uint8_t *entry = content + CONTENT_HEADER + i * HASH_ENTRY;
      if (entry[0] == SHA256_ALGORITHM && !memcmp(entry + 1, v->hashes[h], HASH_LENGTH)) found = true;
    }
    if (!found) { v->error = "Apple ticket does not cover every target code directory"; return; }
  }
  size_t header = 0, length = 0;
  if (!sequence(b + TICKET_HEADER, certificates_length, &header, &length) ||
      length != certificates_length) return;
  SecCertificateRef certificates[CERTIFICATE_COUNT] = {NULL, NULL};
  CFArrayRef chain = NULL;
  SecPolicyRef policy = NULL, revocation = NULL;
  CFArrayRef policies = NULL;
  SecTrustRef trust = NULL;
  SecKeyRef key = NULL;
  CFDataRef message = NULL, signature = NULL;
  CFDictionaryRef properties = NULL;
  size_t cursor = TICKET_HEADER + header;
  for (size_t i = 0; i < CERTIFICATE_COUNT; i++) {
    if (!sequence(b + cursor, content_offset - cursor, &header, &length)) goto done;
    CFDataRef der = CFDataCreate(NULL, b + cursor, (CFIndex)length);
    if (!der) goto unavailable;
    certificates[i] = SecCertificateCreateWithData(NULL, der);
    CFRelease(der);
    if (!certificates[i]) goto done;
    cursor += length;
  }
  if (cursor != content_offset) goto done;
  if (!sequence(b + signature_offset, SIGNATURE_LENGTH, &header, &length)) goto done;
  for (size_t i = length; i < SIGNATURE_LENGTH; i++) if (b[signature_offset + i]) goto done;
  chain = CFArrayCreate(NULL, (const void **)certificates, CERTIFICATE_COUNT, &kCFTypeArrayCallBacks);
  policy = SecPolicyCreateWithProperties(TICKET_POLICY, NULL);
  if (!chain || !policy) goto unavailable;
  properties = SecPolicyCopyProperties(policy);
  if (!properties || !CFDictionaryGetValue(properties, kSecPolicyOid) ||
      !CFEqual(CFDictionaryGetValue(properties, kSecPolicyOid), TICKET_POLICY)) goto unavailable;
  // Consult already available revocation information without requiring an online response.
  revocation = SecPolicyCreateRevocation(kSecRevocationUseAnyAvailableMethod | kSecRevocationNetworkAccessDisabled);
  if (!revocation) goto unavailable;
  const void *policy_values[] = {policy, revocation};
  policies = CFArrayCreate(NULL, policy_values, 2, &kCFTypeArrayCallBacks);
  if (!policies || SecTrustCreateWithCertificates(chain, policies, &trust) != errSecSuccess ||
      SecTrustSetNetworkFetchAllowed(trust, false) != errSecSuccess) goto unavailable;
  v->error = "Apple ticket signing certificate chain was rejected";
  if (!SecTrustEvaluateWithError(trust, NULL)) goto done;
  key = SecCertificateCopyKey(certificates[0]);
  message = CFDataCreate(NULL, b, (CFIndex)signature_offset);
  signature = CFDataCreate(NULL, b + signature_offset, (CFIndex)length);
  if (!key || !message || !signature) goto unavailable;
  v->error = "Apple ticket signature was rejected";
  if (!SecKeyVerifySignature(key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256, message, signature, NULL)) goto done;
  v->error = NULL;
  goto done;
unavailable:
  v->code = UNAVAILABLE;
  v->error = "Offline Apple ticket verifier is unavailable";
done:
  if (signature) CFRelease(signature);
  if (message) CFRelease(message);
  if (key) CFRelease(key);
  if (trust) CFRelease(trust);
  if (policies) CFRelease(policies);
  if (revocation) CFRelease(revocation);
  if (properties) CFRelease(properties);
  if (policy) CFRelease(policy);
  if (chain) CFRelease(chain);
  for (size_t i = 0; i < CERTIFICATE_COUNT; i++) if (certificates[i]) CFRelease(certificates[i]);
}

static void complete(napi_env env, napi_status status, void *data) {
  struct verification *v = data;
  napi_value result, message, code;
  if (status != napi_ok) { v->code = UNAVAILABLE; v->error = "Offline ticket worker did not complete"; }
  if (v->error) {
    napi_create_string_utf8(env, v->error, NAPI_AUTO_LENGTH, &message);
    napi_create_string_utf8(env, v->code, NAPI_AUTO_LENGTH, &code);
    napi_create_error(env, code, message, &result);
    napi_reject_deferred(env, v->deferred, result);
  } else {
    napi_get_undefined(env, &result);
    napi_resolve_deferred(env, v->deferred, result);
  }
  napi_delete_async_work(env, v->work);
  free(v->bytes);
  free(v->application);
  free(v);
}

static napi_value schedule(napi_env env, struct verification *v) {
  napi_value promise, name;
  if (napi_create_promise(env, &v->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "offline-notarization", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute, complete, v, &v->work) != napi_ok) {
    free(v->bytes); free(v->application); free(v); napi_throw_error(env, UNAVAILABLE, "Cannot create ticket worker"); return NULL;
  }
  if (napi_queue_async_work(env, v->work) != napi_ok) {
    napi_delete_async_work(env, v->work); free(v->bytes); free(v->application); free(v);
    napi_throw_error(env, UNAVAILABLE, "Cannot schedule ticket worker"); return NULL;
  }
  return promise;
}
static napi_value verify(napi_env env, napi_callback_info info) {
  size_t argc = 2, size = 0;
  napi_value args[2];
  bool is_buffer = false, is_array = false;
  uint32_t count = 0;
  void *bytes = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_is_buffer(env, args[0], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || !size || size > TICKET_LIMIT ||
      napi_is_array(env, args[1], &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, args[1], &count) != napi_ok || !count || count > MAX_ARCHITECTURES) {
    napi_throw_error(env, UNTRUSTED, "Invalid offline ticket verification input"); return NULL;
  }
  struct verification *v = calloc(1, sizeof(*v));
  if (!v) { napi_throw_error(env, UNAVAILABLE, "Cannot allocate ticket worker"); return NULL; }
  v->bytes = malloc(size);
  if (!v->bytes) { free(v); napi_throw_error(env, UNAVAILABLE, "Cannot copy ticket"); return NULL; }
  memcpy(v->bytes, bytes, size); v->length = size; v->hash_count = count;
  for (uint32_t i = 0; i < count; i++) {
    napi_value hash;
    if (napi_get_element(env, args[1], i, &hash) != napi_ok ||
        napi_is_buffer(env, hash, &is_buffer) != napi_ok || !is_buffer ||
        napi_get_buffer_info(env, hash, &bytes, &size) != napi_ok || size != HASH_LENGTH) {
      free(v->bytes); free(v); napi_throw_error(env, UNTRUSTED, "Invalid code directory digest"); return NULL;
    }
    memcpy(v->hashes[i], bytes, HASH_LENGTH);
  }
  return schedule(env, v);
}

static napi_value verify_signature(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0, copied = 0;
  napi_value arg;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_string_utf8(env, arg, NULL, 0, &length) != napi_ok || !length || length > PATH_LIMIT) {
    napi_throw_error(env, UNTRUSTED, "Invalid application path"); return NULL;
  }
  struct verification *v = calloc(1, sizeof(*v));
  if (!v) { napi_throw_error(env, UNAVAILABLE, "Cannot allocate signature worker"); return NULL; }
  v->application = malloc(length + 1);
  if (!v->application) { free(v); napi_throw_error(env, UNAVAILABLE, "Cannot copy application path"); return NULL; }
  if (napi_get_value_string_utf8(env, arg, v->application, length + 1, &copied) != napi_ok ||
      copied != length || strlen(v->application) != length || v->application[0] != '/') {
    free(v->application); free(v); napi_throw_error(env, UNTRUSTED, "Invalid application path"); return NULL;
  }
  return schedule(env, v);
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "verify", NAPI_AUTO_LENGTH, verify, NULL, &fn);
  napi_set_named_property(env, exports, "verify", fn);
  napi_create_function(env, "verifySignature", NAPI_AUTO_LENGTH, verify_signature, NULL, &fn);
  napi_set_named_property(env, exports, "verifySignature", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
