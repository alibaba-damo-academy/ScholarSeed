#import <Foundation/Foundation.h>

// Private Desktop ABI implemented by the packaged Squirrel framework.
@protocol SSSuccessor <NSObject>
- (BOOL)ss_installSuccessor:(NSError **)error;
- (void)ss_disposeSuccessor;
@end

@protocol SSSuccessorFactory <NSObject>
+ (id<SSSuccessor>)ss_prepareSuccessor:(NSURL *)feed alternate:(BOOL)alternate
                            completion:(void (^)(NSError *error))completion;
@end
