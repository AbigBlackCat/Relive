import SwiftUI

struct CropOverlay: View {
    @Binding var region: CropRegion
    let editing: Bool
    let accent: Color
    @State private var dragOrigin: CropRegion?

    private enum Handle: CaseIterable, Hashable {
        case topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left, move

        var title: String {
            switch self {
            case .topLeft: return "裁剪框左上角"
            case .top: return "裁剪框上边缘"
            case .topRight: return "裁剪框右上角"
            case .right: return "裁剪框右边缘"
            case .bottomRight: return "裁剪框右下角"
            case .bottom: return "裁剪框下边缘"
            case .bottomLeft: return "裁剪框左下角"
            case .left: return "裁剪框左边缘"
            case .move: return "移动裁剪框"
            }
        }

        func point(in rect: CGRect) -> CGPoint {
            switch self {
            case .topLeft: return CGPoint(x: rect.minX, y: rect.minY)
            case .top: return CGPoint(x: rect.midX, y: rect.minY)
            case .topRight: return CGPoint(x: rect.maxX, y: rect.minY)
            case .right: return CGPoint(x: rect.maxX, y: rect.midY)
            case .bottomRight: return CGPoint(x: rect.maxX, y: rect.maxY)
            case .bottom: return CGPoint(x: rect.midX, y: rect.maxY)
            case .bottomLeft: return CGPoint(x: rect.minX, y: rect.maxY)
            case .left: return CGPoint(x: rect.minX, y: rect.midY)
            case .move: return CGPoint(x: rect.midX, y: rect.midY)
            }
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let rect = CGRect(x: CGFloat(region.x) * size.width, y: CGFloat(region.y) * size.height,
                              width: CGFloat(region.width) * size.width, height: CGFloat(region.height) * size.height)
            ZStack(alignment: .topLeading) {
                CropMask(selection: rect)
                    .fill(Color.black.opacity(editing ? 0.58 : 0.65), style: FillStyle(eoFill: true))
                    .allowsHitTesting(false)
                Rectangle()
                    .stroke(editing ? accent : Color.white.opacity(0.6), lineWidth: editing ? 1.5 : 1)
                    .frame(width: rect.width, height: rect.height)
                    .position(x: rect.midX, y: rect.midY)
                    .allowsHitTesting(false)
                if editing {
                    grid(in: rect)
                    Rectangle()
                        .fill(Color.clear)
                        .contentShape(Rectangle())
                        .frame(width: rect.width, height: rect.height)
                        .position(x: rect.midX, y: rect.midY)
                        .gesture(drag(.move, size: size))
                        .accessibilityLabel(Handle.move.title)
                        .accessibilityAction(named: Text("向左移动")) { region = adjusted(region, handle: .move, dx: -0.01, dy: 0) }
                        .accessibilityAction(named: Text("向右移动")) { region = adjusted(region, handle: .move, dx: 0.01, dy: 0) }
                        .accessibilityAction(named: Text("向上移动")) { region = adjusted(region, handle: .move, dx: 0, dy: -0.01) }
                        .accessibilityAction(named: Text("向下移动")) { region = adjusted(region, handle: .move, dx: 0, dy: 0.01) }
                    ForEach([Handle.top, .right, .bottom, .left], id: \.self) { handle in
                        let horizontal = handle == .top || handle == .bottom
                        Rectangle()
                            .fill(Color.clear)
                            .frame(width: horizontal ? rect.width : 14, height: horizontal ? 14 : rect.height)
                            .contentShape(Rectangle())
                            .position(handle.point(in: rect))
                            .gesture(drag(handle, size: size))
                            .accessibilityHidden(true)
                    }
                    ForEach(Array(Handle.allCases.dropLast()), id: \.self) { handle in
                        let point = handle.point(in: rect)
                        Circle()
                            .fill(Color.white)
                            .frame(width: 8, height: 8)
                            .overlay(Circle().stroke(accent, lineWidth: 1.5))
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                            .position(point)
                            .gesture(drag(handle, size: size))
                            .accessibilityLabel(handle.title)
                            .accessibilityAdjustableAction { direction in
                                let step = direction == .increment ? 0.01 : -0.01
                                region = adjusted(region, handle: handle, dx: step, dy: step)
                            }
                            .help("拖动以调整裁剪范围")
                    }
                }
            }
            .coordinateSpace(name: "relive-crop")
        }
        .allowsHitTesting(editing)
    }

    private func grid(in rect: CGRect) -> some View {
        Path { path in
            for fraction in [1.0 / 3, 2.0 / 3] {
                let x = rect.minX + rect.width * fraction
                let y = rect.minY + rect.height * fraction
                path.move(to: CGPoint(x: x, y: rect.minY))
                path.addLine(to: CGPoint(x: x, y: rect.maxY))
                path.move(to: CGPoint(x: rect.minX, y: y))
                path.addLine(to: CGPoint(x: rect.maxX, y: y))
            }
        }
        .stroke(Color.white.opacity(0.3), style: StrokeStyle(lineWidth: 0.5, dash: [4, 4]))
        .allowsHitTesting(false)
    }

    private func drag(_ handle: Handle, size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named("relive-crop"))
            .onChanged { value in
                guard size.width > 0, size.height > 0 else { return }
                if dragOrigin == nil { dragOrigin = region }
                region = adjusted(dragOrigin ?? region, handle: handle,
                                  dx: Double(value.translation.width / size.width),
                                  dy: Double(value.translation.height / size.height))
            }
            .onEnded { _ in dragOrigin = nil }
    }

    private func adjusted(_ original: CropRegion, handle: Handle, dx: Double, dy: Double) -> CropRegion {
        if handle == .move {
            return CropRegion(x: min(1 - original.width, max(0, original.x + dx)),
                              y: min(1 - original.height, max(0, original.y + dy)),
                              width: original.width, height: original.height)
        }
        let minimum = 0.04
        var left = original.x, right = original.x + original.width
        var top = original.y, bottom = original.y + original.height
        if [.topLeft, .left, .bottomLeft].contains(handle) { left = min(right - minimum, max(0, left + dx)) }
        if [.topRight, .right, .bottomRight].contains(handle) { right = max(left + minimum, min(1, right + dx)) }
        if [.topLeft, .top, .topRight].contains(handle) { top = min(bottom - minimum, max(0, top + dy)) }
        if [.bottomLeft, .bottom, .bottomRight].contains(handle) { bottom = max(top + minimum, min(1, bottom + dy)) }
        return CropRegion(x: left, y: top, width: right - left, height: bottom - top)
    }
}

private struct CropMask: Shape {
    let selection: CGRect

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addRect(selection)
        return path
    }
}
