import { noop } from '@suika/common';
import { type IPoint, type IRect, normalizeRect } from '@suika/geo';

import { AddGraphCmd } from '../commands/add_graphs';
import { type ICursor } from '../cursor_manager';
import { type Editor } from '../editor';
import { type Graph } from '../graphs';
import { type ITool } from './type';

/**
 * Draw Graph Tool
 * reference: https://mp.weixin.qq.com/s/lD1qlGus3pRvT5ZfdH0_lg
 */
export abstract class DrawGraphTool implements ITool {
  static readonly type: string = '';
  static readonly hotkey: string = '';
  readonly type: string = '';
  readonly hotkey: string = '';
  cursor: ICursor = 'crosshair';
  commandDesc = 'Add Graph';

  protected drawingGraph: Graph | null = null;

  private startPoint: IPoint = { x: -1, y: -1 };
  private lastDragPoint!: IPoint;
  private lastDragPointInViewport!: IPoint;
  /** lastPoint with snap when dragging */
  private lastMousePoint!: IPoint;
  /**
   * use to calculate the offset, to change the graph's start point
   */
  private startPointWhenSpaceDown: IPoint | null = null;
  private lastDragPointWhenSpaceDown: IPoint | null = null;

  private isDragging = false;
  private unbindEvent: () => void = noop;

  constructor(protected editor: Editor) {}
  onActive() {
    const editor = this.editor;
    const hotkeysManager = editor.hostEventManager;
    const updateRect = () => {
      if (this.isDragging) {
        this.updateRect();
      }
    };
    hotkeysManager.on('shiftToggle', updateRect);
    hotkeysManager.on('altToggle', updateRect);

    // 记录空格键按下时的坐标位置
    const handleSpaceToggle = (isDown: boolean) => {
      if (this.isDragging && isDown) {
        this.startPointWhenSpaceDown = this.startPoint;
        this.lastDragPointWhenSpaceDown = this.lastMousePoint;
        this.updateRect();
      } else {
        this.startPointWhenSpaceDown = null;
        this.lastDragPointWhenSpaceDown = null;
      }
    };
    hotkeysManager.on('spaceToggle', handleSpaceToggle);

    const updateRectWhenViewportTranslate = () => {
      if (editor.hostEventManager.isDraggingCanvasBySpace) {
        return;
      }
      if (this.isDragging) {
        this.lastDragPoint = editor.viewportCoordsToScene(
          this.lastDragPointInViewport.x,
          this.lastDragPointInViewport.y,
          this.editor.setting.get('snapToPixelGrid'),
        );
        this.updateRect();
      }
    };
    editor.viewportManager.on('xOrYChange', updateRectWhenViewportTranslate);

    this.unbindEvent = () => {
      hotkeysManager.off('shiftToggle', updateRect);
      hotkeysManager.off('altToggle', updateRect);
      editor.viewportManager.off('xOrYChange', updateRectWhenViewportTranslate);
      hotkeysManager.off('spaceToggle', handleSpaceToggle);
    };
  }
  onInactive() {
    this.unbindEvent();
  }
  onMoveExcludeDrag() {
    // do nothing;
  }

  onStart(e: PointerEvent) {
    this.startPoint = this.editor.getSceneCursorXY(
      e,
      this.editor.setting.get('snapToPixelGrid'),
    );
    this.drawingGraph = null;
    this.isDragging = false;
    this.startPointWhenSpaceDown = null;
    this.lastDragPointWhenSpaceDown = null;
  }

  onDrag(e: PointerEvent) {
    this.editor.hostEventManager.disableDelete();
    this.editor.hostEventManager.disableContextmenu();
    if (this.editor.hostEventManager.isDraggingCanvasBySpace) {
      return;
    }
    this.isDragging = true;
    this.lastDragPointInViewport = this.editor.getCursorXY(e);
    this.lastDragPoint = this.lastMousePoint = this.editor.getSceneCursorXY(
      e,
      this.editor.setting.get('snapToPixelGrid'),
    );
    this.updateRect();
  }
  /**
   * create graph, and give the original rect (width may be negative)
   * noMove: if true, the graph will not move when drag
   */
  protected abstract createGraph(rect: IRect, noMove?: boolean): Graph | null;

  protected adjustSizeWhenShiftPressing(rect: IRect) {
    // pressing Shift to draw a square
    const { width, height } = rect;
    const size = Math.max(Math.abs(width), Math.abs(height));
    rect.height = (Math.sign(height) || 1) * size;
    rect.width = (Math.sign(width) || 1) * size;
    return rect;
  }

  /**
   * update graph, and give the original rect (width may be negative)
   */
  protected updateGraph(rect: IRect) {
    rect = normalizeRect(rect);
    const drawingShape = this.drawingGraph!;

    drawingShape.updateAttrs({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  /** update drawing rect object */
  private updateRect() {
    if (!this.isDragging) return;

    const { x, y } = this.lastDragPoint;
    const sceneGraph = this.editor.sceneGraph;

    if (this.startPointWhenSpaceDown && this.lastDragPointWhenSpaceDown) {
      const { x: sx, y: sy } = this.startPointWhenSpaceDown;
      const { x: lx, y: ly } = this.lastDragPointWhenSpaceDown;
      const dx = x - lx;
      const dy = y - ly;
      this.startPoint = {
        x: sx + dx,
        y: sy + dy,
      };
    }

    const { x: startX, y: startY } = this.startPoint;

    let width = x - startX;
    let height = y - startY;
    if (width === 0) {
      const sign = Math.sign(this.lastMousePoint.x - this.startPoint.x) || 1;
      width = sign * 1;
    }
    if (height === 0) {
      const sign = Math.sign(this.lastMousePoint.y - this.startPoint.y) || 1;
      height = sign * 1;
    }

    let rect = {
      x: startX,
      y: startY,
      width, // width may be negative
      height, // height may be negative
    };

    // whether to set the starting point as the center of the graph
    const isStartPtAsCenter = this.editor.hostEventManager.isAltPressing;
    // whether to keep the graph square
    const keepSquare = this.editor.hostEventManager.isShiftPressing;

    let cx = 0;
    let cy = 0;
    if (isStartPtAsCenter) {
      rect = {
        x: rect.x - width,
        y: rect.y - height,
        width: rect.width * 2,
        height: rect.height * 2,
      };

      cx = rect.x + rect.width / 2;
      cy = rect.y + rect.height / 2;
    }

    if (keepSquare) {
      rect = this.adjustSizeWhenShiftPressing(rect);
    }

    if (isStartPtAsCenter) {
      rect.x = cx - rect.width / 2;
      rect.y = cy - rect.height / 2;
    }

    if (this.drawingGraph) {
      this.updateGraph(rect);
    } else {
      const element = this.createGraph(rect)!;
      sceneGraph.addItems([element]);

      this.drawingGraph = element;
    }
    this.editor.selectedElements.setItems([this.drawingGraph]);
    sceneGraph.render();
  }

  onEnd(e: PointerEvent) {
    if (this.editor.hostEventManager.isDraggingCanvasBySpace) {
      return;
    }

    const endPoint = this.editor.getSceneCursorXY(
      e,
      this.editor.setting.get('snapToPixelGrid'),
    );

    if (this.drawingGraph === null) {
      const { x: cx, y: cy } = endPoint;
      const width = this.editor.setting.get('drawGraphDefaultWidth');
      const height = this.editor.setting.get('drawGraphDefaultHeight');

      this.drawingGraph = this.createGraph(
        {
          x: cx - width / 2,
          y: cy - height / 2,
          width,
          height,
        },
        true,
      );
      if (this.drawingGraph) {
        this.editor.sceneGraph.addItems([this.drawingGraph]);

        this.editor.selectedElements.setItems([this.drawingGraph]);
        this.editor.render();
      }
    }

    if (this.drawingGraph) {
      this.editor.commandManager.pushCommand(
        new AddGraphCmd(this.commandDesc, this.editor, [this.drawingGraph]),
      );
    }
  }

  afterEnd() {
    this.isDragging = false;
    this.editor.hostEventManager.enableDelete();
    this.editor.hostEventManager.enableContextmenu();
    if (
      this.drawingGraph &&
      !this.editor.setting.get('keepToolSelectedAfterUse')
    ) {
      this.editor.toolManager.setActiveTool('select');
    }
    this.startPointWhenSpaceDown = null;
    this.lastDragPointWhenSpaceDown = null;
  }
}
