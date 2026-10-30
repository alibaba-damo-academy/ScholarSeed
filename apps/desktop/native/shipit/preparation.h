#import <Foundation/Foundation.h>

// The installer holds SSCleanupOpen's lock as well for the complete lifecycle.
BOOL SSPreparationOpen(NSString *label, NSError **error);
BOOL SSPreparationOpenDirectory(NSString *directory, NSError **error);
// Prepare before waiting for termination. Reuse does not replace signature validation.
NSURL *SSPreparationCopy(NSURL *source, NSURL *target, NSDictionary *binding, NSError **error);
BOOL SSPreparationValidate(NSURL *source, NSURL *target, NSDictionary *binding, NSURL *candidate, NSError **error);
typedef NS_ENUM(NSInteger, SSPreparationFailure) {
    SSPreparationFailureInvalid = -1,
    SSPreparationFailureNone = 0,
    SSPreparationFailureRestored = 1,
};
BOOL SSPreparationRecordFailure(NSURL *source, NSURL *actualTarget, NSDictionary *binding, NSInteger code, NSError **error);
SSPreparationFailure SSPreparationRecoverFailure(NSURL *source, NSURL *target, NSDictionary *binding, NSInteger *code, NSError **error);
BOOL SSPreparationRetire(NSURL *source, NSURL *target, NSError **error);
void SSPreparationClose(void);
