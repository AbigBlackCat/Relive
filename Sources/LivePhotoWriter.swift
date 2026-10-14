import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

enum LivePhotoWriter {
    private static let contentIdentifier = "com.apple.quicktime.content.identifier"
    private static let stillImageTime = "com.apple.quicktime.still-image-time"

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func write(video: URL, coverTime: Double, outputDirectory: URL, name: String) async throws -> URL {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0"), name.utf8.count <= 220 else {
            throw Failure(message: "导出名称不合法，请使用较短的文件名。")
        }
        guard coverTime.isFinite, coverTime >= 0 else {
            throw Failure(message: "封面时间必须是大于或等于 0 的秒数。")
        }
        try Task.checkCancellation()
        let asset = AVURLAsset(url: video)
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw Failure(message: "视频没有可读取的画面。")
        }
        let duration = try await asset.load(.duration)
        let seconds = duration.seconds
        guard seconds.isFinite, seconds > 0, coverTime <= seconds + 0.001 else {
            throw Failure(message: "封面时间超出了视频范围。")
        }
        let frameRate = try await videoTrack.load(.nominalFrameRate)
        let frameSeconds = frameRate > 0 ? 1.0 / Double(frameRate) : 1.0 / 30.0
        let requestedTime = CMTime(seconds: min(coverTime, max(0, seconds - frameSeconds)), preferredTimescale: 60000)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let cover = try await generator.image(at: requestedTime)
        try Task.checkCancellation()

        let files = FileManager.default
        try files.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let package = outputDirectory.appendingPathComponent(name + ".pvt", isDirectory: true)
        guard !files.fileExists(atPath: package.path) else {
            throw Failure(message: "已有同名 Live Photo，请换一个名称。")
        }
        let staging = outputDirectory.appendingPathComponent(".relive-" + UUID().uuidString + ".pvt", isDirectory: true)
        try files.createDirectory(at: staging, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: staging) }
        let identifier = UUID().uuidString
        let imageURL = staging.appendingPathComponent(name + ".jpg")
        let movieURL = staging.appendingPathComponent(name + ".mov")
        try writeJPEG(cover.image, to: imageURL, identifier: identifier)
        try await writeMovie(asset: asset, videoTrack: videoTrack, to: movieURL, identifier: identifier,
                             coverTime: cover.actualTime, frameDuration: CMTime(seconds: frameSeconds, preferredTimescale: 60000), duration: duration)
        let plist = try PropertyListSerialization.data(fromPropertyList: ["PFVideoComplementMetadataVersionKey": "1"], format: .xml, options: 0)
        try plist.write(to: staging.appendingPathComponent("metadata.plist"), options: .atomic)
        try await validate(package: staging)
        try Task.checkCancellation()
        // Moving a new package refuses an existing destination, including one created during export.
        try files.moveItem(at: staging, to: package)
        return package
    }

    private static func writeJPEG(_ image: CGImage, to url: URL, identifier: String) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw Failure(message: "无法创建封面图片。")
        }
        let properties: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: 0.95,
            kCGImagePropertyMakerAppleDictionary: ["17": identifier],
            kCGImagePropertyOrientation: 1
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw Failure(message: "封面图片写入失败。")
        }
    }

    private static func metadataItem(key: String, value: any NSCopying & NSObjectProtocol, dataType: String) -> AVMutableMetadataItem {
        let item = AVMutableMetadataItem()
        item.keySpace = .quickTimeMetadata
        item.key = key as NSString
        item.value = value
        item.dataType = dataType
        return item
    }

    private static func writeMovie(asset: AVAsset, videoTrack: AVAssetTrack, to url: URL, identifier: String,
                                   coverTime: CMTime, frameDuration: CMTime, duration: CMTime) async throws {
        let reader = try AVAssetReader(asset: asset)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.metadata = [metadataItem(key: contentIdentifier, value: identifier as NSString, dataType: kCMMetadataBaseDataType_UTF8 as String)]
        var transfers: [(output: AVAssetReaderTrackOutput, input: AVAssetWriterInput)] = []
        let tracks = [videoTrack] + (try await asset.loadTracks(withMediaType: .audio))
        for track in tracks {
            let descriptions = try await track.load(.formatDescriptions)
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
            output.alwaysCopiesSampleData = false
            let input = AVAssetWriterInput(mediaType: track.mediaType, outputSettings: nil, sourceFormatHint: descriptions.first)
            input.expectsMediaDataInRealTime = false
            if track.mediaType == .video {
                input.transform = try await track.load(.preferredTransform)
            }
            guard reader.canAdd(output), writer.canAdd(input) else {
                throw Failure(message: "视频或声音不能写入 Live Photo。请先转为 H.264 / AAC。")
            }
            reader.add(output)
            writer.add(input)
            transfers.append((output, input))
        }

        var format: CMFormatDescription?
        let specification: [String: Any] = [
            kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as String: "mdta/" + stillImageTime,
            kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as String: kCMMetadataBaseDataType_SInt8 as String
        ]
        let status = CMMetadataFormatDescriptionCreateWithMetadataSpecifications(allocator: kCFAllocatorDefault,
            metadataType: kCMMetadataFormatType_Boxed, metadataSpecifications: [specification] as CFArray, formatDescriptionOut: &format)
        guard status == noErr, let format else {
            throw Failure(message: "Live Photo 封面标记创建失败（\(status)）。")
        }
        let metadataInput = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil, sourceFormatHint: format)
        metadataInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(metadataInput) else {
            throw Failure(message: "视频不支持 Live Photo 封面标记。")
        }
        writer.add(metadataInput)
        let adaptor = AVAssetWriterInputMetadataAdaptor(assetWriterInput: metadataInput)
        if let videoInput = transfers.first?.input,
           metadataInput.canAddTrackAssociation(withTrackOf: videoInput, type: AVAssetTrack.AssociationType.metadataReferent.rawValue) {
            metadataInput.addTrackAssociation(withTrackOf: videoInput, type: AVAssetTrack.AssociationType.metadataReferent.rawValue)
        }
        guard writer.startWriting() else { throw writer.error ?? Failure(message: "无法开始写入 Live Photo。") }
        writer.startSession(atSourceTime: .zero)
        guard reader.startReading() else {
            writer.cancelWriting()
            throw reader.error ?? Failure(message: "无法开始读取视频。")
        }
        do {
            while !metadataInput.isReadyForMoreMediaData {
                try Task.checkCancellation()
                guard writer.status == .writing else { throw writer.error ?? Failure(message: "Live Photo 写入中断。") }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            let marker = metadataItem(key: stillImageTime, value: NSNumber(value: Int8(0)), dataType: kCMMetadataBaseDataType_SInt8 as String)
            let remaining = CMTimeSubtract(duration, coverTime)
            let markerDuration = CMTimeCompare(frameDuration, remaining) <= 0 ? frameDuration : remaining
            guard adaptor.append(AVTimedMetadataGroup(items: [marker], timeRange: CMTimeRange(start: coverTime, duration: markerDuration))) else {
                throw writer.error ?? Failure(message: "Live Photo 封面标记写入失败。")
            }
            metadataInput.markAsFinished()

            var finished = Set<Int>()
            while finished.count < transfers.count {
                try Task.checkCancellation()
                guard writer.status == .writing else { throw writer.error ?? Failure(message: "Live Photo 写入中断。") }
                var madeProgress = false
                // Interleave ready tracks so an audio queue cannot stall the video queue.
                for (index, transfer) in transfers.enumerated() where !finished.contains(index) && transfer.input.isReadyForMoreMediaData {
                    if let sample = transfer.output.copyNextSampleBuffer() {
                        guard transfer.input.append(sample) else {
                            throw writer.error ?? Failure(message: "视频帧或声音写入失败。")
                        }
                    } else {
                        guard reader.status != .failed, reader.status != .cancelled else {
                            throw reader.error ?? Failure(message: "视频读取中断。")
                        }
                        transfer.input.markAsFinished()
                        finished.insert(index)
                    }
                    madeProgress = true
                }
                if !madeProgress { try await Task.sleep(nanoseconds: 1_000_000) }
            }
            writer.endSession(atSourceTime: duration)
            await withCheckedContinuation { continuation in
                writer.finishWriting { continuation.resume() }
            }
            guard writer.status == .completed else {
                throw writer.error ?? Failure(message: "Live Photo 视频完成写入时出错。")
            }
        } catch {
            reader.cancelReading()
            writer.cancelWriting()
            throw error
        }
    }

    static func validate(package: URL) async throws {
        try Task.checkCancellation()
        let resources = try FileManager.default.contentsOfDirectory(at: package, includingPropertiesForKeys: nil)
        let images = resources.filter { $0.pathExtension.lowercased() == "jpg" }
        let movies = resources.filter { $0.pathExtension.lowercased() == "mov" }
        guard images.count == 1, movies.count == 1,
              let source = CGImageSourceCreateWithURL(images[0] as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let maker = properties[kCGImagePropertyMakerAppleDictionary as String] as? [String: Any],
              let imageIdentifier = maker["17"] as? String, !imageIdentifier.isEmpty else {
            throw Failure(message: "Live Photo 文件缺少有效的封面或配对标记。")
        }
        let plistData = try Data(contentsOf: package.appendingPathComponent("metadata.plist"))
        let plist = try PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any]
        guard plist?["PFVideoComplementMetadataVersionKey"] as? String == "1" else {
            throw Failure(message: "Live Photo 包的 metadata.plist 不正确。")
        }
        let asset = AVURLAsset(url: movies[0])
        let metadata = try await asset.load(.metadata)
        let identifierItem = metadata.first(where: { $0.keySpace == .quickTimeMetadata && $0.key as? String == contentIdentifier })
        guard let identifierItem, let movieIdentifier = try await identifierItem.load(.stringValue),
              movieIdentifier == imageIdentifier else {
            throw Failure(message: "Live Photo 图片和视频的配对标记不匹配。")
        }
        let metadataTracks = try await asset.loadTracks(withMediaType: .metadata)
        var foundMarker = false
        for track in metadataTracks {
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
            guard reader.canAdd(output) else { continue }
            reader.add(output)
            let adaptor = AVAssetReaderOutputMetadataAdaptor(assetReaderTrackOutput: output)
            guard reader.startReading() else { continue }
            while let group = adaptor.nextTimedMetadataGroup() {
                if group.items.contains(where: { $0.key as? String == stillImageTime }) { foundMarker = true }
            }
            if foundMarker { break }
        }
        guard foundMarker else { throw Failure(message: "Live Photo 视频缺少封面时间标记。") }
        try await validateWithPhotos(resources: [images[0], movies[0]])
        try Task.checkCancellation()
    }

    @MainActor
    private static func validateWithPhotos(resources: [URL]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = ValidationGate(continuation)
            gate.requestID = PHLivePhoto.request(withResourceFileURLs: resources, placeholderImage: nil, targetSize: .zero, contentMode: .aspectFit) { photo, info in
                if let error = info[PHLivePhotoInfoErrorKey] as? Error {
                    gate.finish(.failure(Failure(message: "Apple Live Photo 验证未通过：\(error.localizedDescription)")))
                } else if (info[PHLivePhotoInfoCancelledKey] as? NSNumber)?.boolValue == true {
                    gate.finish(.failure(CancellationError()))
                } else if (info[PHLivePhotoInfoIsDegradedKey] as? NSNumber)?.boolValue != true {
                    gate.finish(photo == nil ? .failure(Failure(message: "Apple 未将这组文件识别为 Live Photo。")) : .success(()))
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
                if gate.finish(.failure(Failure(message: "Apple Live Photo 验证超时，请重试。"))) {
                    PHLivePhoto.cancelRequest(withRequestID: gate.requestID)
                }
            }
        }
    }

    private final class ValidationGate {
        var requestID: PHLivePhotoRequestID = PHLivePhotoRequestIDInvalid
        private var continuation: CheckedContinuation<Void, Error>?
        init(_ continuation: CheckedContinuation<Void, Error>) { self.continuation = continuation }
        @discardableResult
        func finish(_ result: Result<Void, Error>) -> Bool {
            guard let continuation else { return false }
            self.continuation = nil
            continuation.resume(with: result)
            return true
        }
    }
}
