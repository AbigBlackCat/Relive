#import <AppKit/AppKit.h>
#import <Photos/Photos.h>

// This exercises Apple's decoder without importing anything into the Photos library.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 2;
        __block BOOL finished = NO, passed = NO;
        NSArray *resources = @[[NSURL fileURLWithPath:@(argv[1])], [NSURL fileURLWithPath:@(argv[2])]];
        PHLivePhotoRequestID request = [PHLivePhoto requestLivePhotoWithResourceFileURLs:resources
            placeholderImage:nil targetSize:CGSizeZero contentMode:PHImageContentModeAspectFit
            resultHandler:^(PHLivePhoto *photo, NSDictionary *info) {
                if (info[PHLivePhotoInfoErrorKey] || [info[PHLivePhotoInfoCancelledKey] boolValue]) {
                    fprintf(stderr, "%s\n", [info.description UTF8String]);
                    finished = YES;
                } else if (![info[PHLivePhotoInfoIsDegradedKey] boolValue]) {
                    passed = photo != nil;
                    finished = YES;
                }
            }];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:25];
        while (!finished && deadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (!finished) [PHLivePhoto cancelLivePhotoRequestWithRequestID:request];
        puts(passed ? "PASS Apple PHLivePhoto decoder" : "FAIL Apple PHLivePhoto decoder");
        return passed ? 0 : 1;
    }
}
