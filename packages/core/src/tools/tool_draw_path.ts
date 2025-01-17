import { cloneDeep, getClosestTimesVal, parseHexToRGBA } from '@suika/common';
import { distance, type IMatrixArr, type IPoint } from '@suika/geo';

import { AddGraphCmd, SetGraphsAttrsCmd } from '../commands';
import { ControlHandle } from '../control_handle_manager';
import { type ICursor } from '../cursor_manager';
import { type Editor } from '../editor';
import { Ellipse, type IPathItem, type ISegment, Path } from '../graphs';
import { PaintType } from '../paint';
import { PathSelectTool } from './tool_path_select';
import { type ITool } from './type';

const TYPE = 'drawPath';
const HOTKEY = 'p';

export class DrawPathTool implements ITool {
  static readonly type = TYPE;
  static readonly hotkey = HOTKEY;
  readonly type = TYPE;
  readonly hotkey = HOTKEY;
  cursor: ICursor = 'pen';

  private startPoint: IPoint | null = null;
  private path: Path | null = null;
  private prevAttrs: {
    transform: IMatrixArr;
    pathData: IPathItem[];
  } | null = null;
  private pathIdx = 0;

  constructor(private editor: Editor) {}
  onActive() {
    if (this.editor.pathEditor.isActive()) {
      this.path = this.editor.pathEditor.getPath()!;
      this.pathIdx = this.path.attrs.pathData.length;
    }
    this.updateControlHandlesWithPreviewHandles(this.getCorrectedPoint());
  }
  onInactive() {
    this.editor.commandManager.batchCommandEnd();

    this.editor.pathEditor.updateControlHandles();
    this.editor.render();
  }

  onMoveExcludeDrag(_e: PointerEvent, isOutsideCanvas: boolean) {
    const editor = this.editor;
    if (isOutsideCanvas) {
      editor.pathEditor.updateControlHandles();
      editor.render();
      return;
    }

    if (this.editor.canvasDragger.isActive()) {
      editor.pathEditor.updateControlHandles();
    } else {
      const snapPoint = this.checkCursorPtInStartAnchor();
      if (snapPoint) {
        editor.setCursor('pen-close');
      } else {
        editor.setCursor('pen');
      }
      this.updateControlHandlesWithPreviewHandles(
        snapPoint ?? this.getCorrectedPoint(),
      );
    }
  }

  onStart() {
    const pathEditor = this.editor.pathEditor;
    const snapPoint = this.checkCursorPtInStartAnchor();
    this.startPoint = snapPoint ?? this.getCorrectedPoint();

    // create new path
    if (!pathEditor.isActive()) {
      const pathData: IPathItem[] = [
        {
          segs: [
            {
              point: { x: 0, y: 0 },
              in: { x: 0, y: 0 },
              out: { x: 0, y: 0 },
            },
          ],
          closed: false,
        },
      ];

      const path = new Path(
        {
          objectName: '',
          width: 100,
          height: 100,
          strokeWidth: 1,
          stroke: [
            {
              type: PaintType.Solid,
              attrs: parseHexToRGBA('#000')!,
            },
          ],
          pathData,
        },
        this.startPoint,
      );
      this.path = path;

      this.editor.sceneGraph.addItems([path]);
      this.editor.commandManager.batchCommandStart();
      this.editor.commandManager.pushCommand(
        new AddGraphCmd('Add Path', this.editor, [path]),
        {
          beforeRedo: () => {
            this.editor.pathEditor.active(path);
            this.editor.toolManager.setActiveTool(PathSelectTool.type);
          },
          beforeUndo: () => {
            this.editor.pathEditor.inactive('undo');
          },
        },
      );
      this.editor.selectedElements.setItems([path]);

      this.prevAttrs = cloneDeep({
        transform: path.attrs.transform,
        pathData: path.attrs.pathData,
      });

      pathEditor.active(path);
    }
    // add new anchor
    else {
      const path = this.path!;
      this.prevAttrs = cloneDeep({
        transform: path.attrs.transform,
        pathData: path.attrs.pathData,
      });

      // TODO: 应该改为判断是否选中了 path 的末尾 anchor
      // 如果是，则继续绘制。
      if (pathEditor.selectedControl.getSize() === 0) {
        this.pathIdx = path.getPathItemCount();
      }

      if (!path.hasPath(this.pathIdx)) {
        path.addEmptyPath();
      }
      // 是否因为闭合，而修改第一个 anchor 的 in
      if (snapPoint) {
        path.setPathItemClosed(this.pathIdx, true);
        path.setSeg(this.pathIdx, 0, {
          in: { x: 0, y: 0 },
        });
      } else {
        path.addSeg(this.pathIdx, {
          point: this.startPoint,
          in: { x: 0, y: 0 },
          out: { x: 0, y: 0 },
        });
      }
    }

    const lastSegIdx = this.path!.getSegCount(this.pathIdx) - 1;
    const selectSegIdx = this.checkPathItemClosed() ? 0 : lastSegIdx;
    pathEditor.selectedControl.setItems([
      {
        type: 'anchor',
        pathIdx: this.pathIdx,
        segIdx: selectSegIdx,
      },
    ]);

    pathEditor.updateControlHandles();
    this.editor.render();
  }

  onDrag() {
    if (!this.startPoint) {
      console.warn('startPoint is null, check start()');
      return;
    }

    const point = this.getCorrectedPoint();

    const dx = point.x - this.startPoint.x;
    const dy = point.y - this.startPoint.y;

    const path = this.path!;
    const lastSegIdx = path.getSegCount(this.pathIdx) - 1;
    // mirror angle and length
    const inAndOut: Partial<ISegment> = {
      out: { x: dx, y: dy },
    };
    // （1）按住 alt 时不需要满足对称（2）绘制第一个点时，in 保持为 0
    if (!this.editor.hostEventManager.isAltPressing && lastSegIdx !== 0) {
      inAndOut.in = { x: -dx, y: -dy };
    }
    path.setSeg(
      this.pathIdx,
      path.checkPathItemClosed(this.pathIdx) ? 0 : lastSegIdx,
      inAndOut,
    );

    this.editor.pathEditor.updateControlHandles();
    this.editor.render();
  }

  private checkPathItemClosed() {
    return this.path?.checkPathItemClosed(this.pathIdx) ?? false;
  }

  onEnd() {
    // TODO: 如果是 closed，结束当前 path 的绘制
    if (this.checkPathItemClosed()) {
      this.editor.pathEditor.selectedControl.setItems([]);
    }
    const path = this.path!;
    path.updateAttrs({ pathData: path.attrs.pathData });
    this.editor.commandManager.pushCommand(
      new SetGraphsAttrsCmd(
        'Update Path Data',
        [path],
        [
          cloneDeep({
            transform: path.attrs.transform,
            pathData: path.attrs.pathData,
          }),
        ],
        [this.prevAttrs!],
      ),
    );
    this.editor.commandManager.batchCommandEnd();
  }

  afterEnd() {
    this.startPoint = null;
  }

  onCommandChange() {
    this.updateControlHandlesWithPreviewHandles(this.getCorrectedPoint());
  }

  onCanvasDragActiveChange(active: boolean) {
    if (active) {
      this.editor.pathEditor.updateControlHandles();
    } else {
      this.updateControlHandlesWithPreviewHandles(this.getCorrectedPoint());
    }
    this.editor.render();
  }

  onAltToggle() {
    if (!this.startPoint) return;
    this.onDrag();
  }

  /**
   * check if cursor inside start anchor.
   * if true, return start anchor point
   */
  private checkCursorPtInStartAnchor(): IPoint | null {
    const path = this.path;
    if (path) {
      if (path.getPathItemCount() <= this.pathIdx) {
        return null;
      }
      if (path.getSegCount(this.pathIdx) > 1) {
        const startAnchorPoint = path.getSeg(this.pathIdx, 0, {
          applyTransform: true,
        })!.point;
        const point = this.editor.toolManager.getCurrPoint();
        const anchorSize = 5;
        const isInside =
          distance(startAnchorPoint, point) <=
          this.editor.viewportSizeToScene(anchorSize);
        return isInside ? { ...startAnchorPoint } : null;
      }
    }
    return null;
  }

  /** get corrected cursor point */
  private getCorrectedPoint() {
    const point = this.editor.toolManager.getCurrPoint();
    if (this.editor.setting.get('snapToPixelGrid')) {
      point.x = getClosestTimesVal(point.x, 0.5);
      point.y = getClosestTimesVal(point.y, 0.5);
    }
    return point;
  }

  onViewportXOrYChange() {
    if (this.editor.canvasDragger.isActive()) {
      this.editor.pathEditor.updateControlHandles();
    } else {
      this.updateControlHandlesWithPreviewHandles(this.getCorrectedPoint());
    }
    this.editor.render();
  }

  private updateControlHandlesWithPreviewHandles(point: IPoint) {
    const previewHandles: ControlHandle[] = [];

    if (this.editor.pathEditor.selectedControl.getSize() > 0) {
      const path = this.path;
      if (!path) return;
      const lastSeg = path.getLastSeg(this.pathIdx, {
        applyTransform: true,
      });
      if (lastSeg) {
        const previewCurve = new ControlHandle({
          cx: point.x,
          cy: point.y,
          type: 'path-preview-curve',
          getCursor: () => 'default',
          graph: new Path({
            objectName: 'path-preview-curve',
            width: 0,
            height: 0,
            pathData: [
              {
                segs: [
                  {
                    point: this.editor.sceneCoordsToViewport(
                      lastSeg.point.x,
                      lastSeg.point.y,
                    ),
                    in: {
                      x: this.editor.sceneSizeToViewport(lastSeg.in.x),
                      y: this.editor.sceneSizeToViewport(lastSeg.in.y),
                    },
                    out: {
                      x: this.editor.sceneSizeToViewport(lastSeg.out.x),
                      y: this.editor.sceneSizeToViewport(lastSeg.out.y),
                    },
                  },
                  {
                    point: this.editor.sceneCoordsToViewport(point.x, point.y),
                    in: { x: 0, y: 0 },
                    out: { x: 0, y: 0 },
                  },
                ],
                closed: false,
              },
            ],
            stroke: [
              {
                type: PaintType.Solid,
                attrs: parseHexToRGBA('#1592fe')!,
              },
            ],
            strokeWidth: 1,
          }),
        });
        previewHandles.push(previewCurve);
      }
    }

    const handleStroke = this.editor.setting.get('handleStroke');

    const previewPoint = new ControlHandle({
      cx: point.x,
      cy: point.y,
      type: 'path-preview-anchor',
      getCursor: () => 'default',
      graph: new Ellipse(
        {
          objectName: 'path-preview-anchor',
          width: 6,
          height: 6,
          fill: [
            {
              type: PaintType.Solid,
              attrs: parseHexToRGBA('#fff')!,
            },
          ],
          stroke: [
            {
              type: PaintType.Solid,
              attrs: parseHexToRGBA(handleStroke)!,
            },
          ],
          strokeWidth: 1,
        },
        point,
      ),
    });
    previewHandles.push(previewPoint);

    this.editor.pathEditor.updateControlHandles(previewHandles);
    this.editor.render();
  }
}
