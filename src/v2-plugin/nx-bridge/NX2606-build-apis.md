# NX 2606 建模特征构建 API 全参考（反射实测 2026-09-13）

> 全部签名来自 **2606.3002 反射 dump 实录取证**（`~/usr/tmp/opencode/nx2606/_api_*.cs` 探针），
> 非文档转抄。供 MCP 工具调用 journal.run 构建特征时查用。
> 另有构建时实测坑（加粗标注），全部可复现。

---

## 0. 正确调用方法（固化，2026-09-13 实测盖章）

> **本段是本插件 19 工具的「正确调用清单」，所有会话一律照此调用，勿再走下划线/扁平名。**

### 0.1 命名空间与路径（execute/Code Mode 里）

- 插件注册为 MCP server，**名字空间是连字符 `nx-bridge`**（opencode.json `mcp.servers.nx-bridge`）。
- execute（Code Mode）内调用**必须用字典路径**，**不要**用下划线扁平名 `nx_bridge_*` / `nx_bridge_server_ping`：

```js
// ✅ 正确
await tools["nx-bridge"]["server_ping"]({});
await tools["nx-bridge"]["part_work"]({});
await tools["nx-bridge"]["journal_run"]({ code: "…NXOpen C# 语句…" });
await tools["nx-bridge"]["api_reference"]({});   // 返回本文件全文（含本固化节）
```

- 工具名（19 个）都是**下划线**小写蛇形：`server_ping / session_info / session_undo / session_redo /
  part_work / part_new_display / part_open / part_save / part_close_all / model_tree /
  feature_block / feature_cylinder / feature_sphere / feature_suppress / feature_unsuppress /
  measure_distance / ui_message / journal_run / api_reference`。
- 命名空间键**是连字符**（`tools["nx-bridge"]`），不是下划线（`nx_bridge` 会报
  `Cannot access ... on non-object`）；工具名里 journal_run 之外的都可直接按上式调用。

### 0.2 三件日常必用

1. **servack 健康检查**：`server_ping` → `{pong:true,nxVersion:"2606.3002"}`。
2. **当前工作部件**：`part_work` → `{fullPath, name, modified}`。
3. **复杂建模万能口 journal_run**：入参 `{code:"<NXOpen C# 语句序列>"}`，宿主已预置
   `theSession / work / uf / sb` 与 `string RESULT`，把结果赋给 `RESULT` 即作为返回值；
   编译/运行错误原样返回（宿主 SplitErrors 只读 stderr 的 bug 见 AGENTS.md §2，已用
   `journal_run.sh` 闭环绕开）。写 journal 前先 `api_reference` 拿本文件全部签名。

---

## 1. 入口集合与方法签名（work.Features = `NXOpen.Features.FeatureCollection`）

```csharp
work = theSession.Parts.Work;            // journal.run 上下文已定义
work.Features.CreateBlockFeatureBuilder(Feature block)     -> BlockFeatureBuilder
work.Features.CreateCylinderBuilder(Feature cylinder)      -> CylinderBuilder
work.Features.CreateConeBuilder(Cone cone)                 -> ConeBuilder
work.Features.CreateSphereBuilder(Sphere sphere)           -> SphereBuilder
work.Features.CreateExtrudeBuilder(Feature extrude)        -> ExtrudeBuilder
work.Features.CreateRevolveBuilder(Feature revolve)        -> RevolveBuilder
work.Features.CreateHoleFeatureBuilder(Feature hole)       -> HoleFeatureBuilder
work.Features.CreateBooleanBuilder(BooleanFeature bf)      -> BooleanBuilder
work.Features.CreateBooleanBuilderUsingCollector(BooleanFeature bf) -> BooleanBuilder
work.Features.CreateThreadBuilder(Thread thread)           -> ThreadBuilder
work.Features.CreateEdgeBlendBuilder(Feature edgeblend)    -> EdgeBlendBuilder
work.Features.CreateChamferBuilder(Feature chamfer)        -> ChamferBuilder
work.Features.CreateShellBuilder(Feature shell)            -> ShellBuilder
work.Features.CreateDatumPlaneBuilder(Feature dplane)      -> DatumPlaneBuilder
work.Features.CreateDatumAxisBuilder(Feature datumAxis)    -> DatumAxisBuilder
work.Features.CreateDraftBodyBuilder(Feature draftBody)    -> DraftBodyBuilder
```

- **关键用法**：首次创建新特征传 `null`；编辑已有特征传该特征对象。
- **布尔三方法（体合并/求差/求交，直接用，最常用）**：
```csharp
BooleanFeature[] CreateUniteFeature(Body targetBody, Boolean retainTargetBody,
    Body[] toolBodies, Boolean retainToolBodies, Boolean allowNonAssociativeBoolean,
    out Boolean nonAssociativeBoolean, out Boolean unparameterizedSolids)
```
  同签名还有 `CreateSubtractFeature(...)`、`CreateIntersectFeature(...)`。
  返回 `BooleanFeature[]`（通常 1 项）。⚠️ 实测：多 tool 时建议**分步逐个合并**，避免 NX 对互不相交 tool 报错。

### 齿轮（GCTools 子集合）
```csharp
work.Features.GCToolsFeatureCollection.CreateCylinderGearBuilder(CylinderGear) -> CylinderGearBuilder
work.Features.GCToolsFeatureCollection.CreateRackBuilder(Rack)  -> RackBuilder
work.Features.GCToolsFeatureCollection.CreateBevelGearBuilder(BevelGear) -> BevelGearBuilder
work.Features.GCToolsFeatureCollection.CreateEngageGearBuilder() -> EngageGearBuilder
```

---

## 2. 基类通用协议（所有 Builder 子类共有）

继承链：`FeatureBuilder → Builder → TaggedObject → NXRemotableObject → MarshalByRefObject`

| 成员 | 说明 |
| --- | --- |
| `NXObject Commit()`（Builder） | **提交特征**，返回创建的 NXObject（Feature） |
| `Void Destroy()`（Builder） | 释放 builder，用后必调 |
| `Feature CommitFeature()`（FeatureBuilder） | 提交并返回 Feature |
| `Feature GetFeature()` | 取当前关联特征 |
| `Body[] GetPreviewBody()` | 预览实体（未提交） |
| `NXObject[] GetCommittedObjects()` | 本次提交产物 |
| `Boolean Validate()` | 校验参数是否合法 |
| `Void ShowResults()` | 显示结果 |
| `NXObject GetObject()` | 内部关联对象 |

**标准生命周期**：`CreateXxxBuilder(null)` → 设属性 → `var feat = builder.Commit()` → `builder.Destroy()`。

---
## 3. 布尔运算三通道（任一即可）

**(A) 体素/拉伸类 builder 内置 `BooleanOption`**（属性类型 `NXOpen.GeometricUtilities.BooleanOperation`）：
```csharp
builder.BooleanOption.Type = NXOpen.GeometricUtilities.BooleanOperation.BooleanType.Subtract; // 或 Unite / Intersect / Create
builder.BooleanOption.SetTargetBodies(new Body[] { targetBody });
```

**(B) 无 builder 直接法**：`CreateUniteFeature / CreateSubtractFeature / CreateIntersectFeature`（见上）。

**(C) BooleanBuilder 通用布尔**：
```csharp
var bb = work.Features.CreateBooleanBuilder(null);
bb.Operation = BooleanType.Subtract;  // 属性类型 BooleanType 枚举
bb.Target = targetBody;               // 目标体
bb.Tool = toolBody;                   // 工具体
var f = bb.Commit(); bb.Destroy();
```
其它属性：`RetainTarget/RetainTool/CopyTargets/CopyTools/ConvertToSew/RemoveTargetVoids/Tolerance`。

### BooleanOperation 类成员（BooleanOption 的类型）
```
prop BooleanType Type { get; set; }
method Void SetTargetBodies(Body[] targetBodies)
method Body[] GetTargetBodies()
method Void SetBooleanOperationAndBody(BooleanType type, Body targetBody)
method Void GetBooleanOperationAndBody(out BooleanType type, out Body targetBody)
method ScCollector GetTargetBodiesCollector()
method Boolean Validate()
```

### BooleanType 枚举值
```
Create = 0    Unite = 1    Subtract = 2    Intersect = 3    Sew = 4
```

---

## 4. 各 Builder 详细属性/方法

### 4.1 BlockFeatureBuilder（长方体）
```
prop BooleanOperation BooleanOption { get; }      prop BooleanType BooleanType { get; set; }
prop Expression Length/Width/Height { get; }      prop Point3d Origin { get; set; }
prop Point OriginPoint { get; set; }              prop Point PointFromOrigin { get; set; }
prop Body Target { get; set; }                    prop Types Type { get; set; }
prop Boolean ParentAssociativity { get; set; }
method Void SetOriginAndLengths(Point3d origin, String length, String width, String height)
method Void SetLength(String) / SetWidth(String) / SetHeight(String)
method Void SetOrientation(Vector3d xAxis, Vector3d yAxis)
method Void GetOrientation(out Vector3d xAxis, out Vector3d yAxis)
method Void SetTwoPointsAndHeight(Point3d origin, Point3d corner, String height)
method Void SetTwoDiagonalPoints(Point3d origin, Point3d corner)
method Void SetBooleanOperationAndTarget(BooleanType op, Body target)
```

### 4.2 CylinderBuilder（圆柱）
```
prop Point3d Origin { get; set; }     prop Vector3d Direction { get; set; }
prop Expression Diameter { get; }     prop Expression Height { get; }
prop BooleanOperation BooleanOption { get; }   prop Boolean ReverseDirection { get; set; }
prop Axis Axis { get; set; }          prop SelectICurve Arc { get; }
prop Types Type { get; set; }
```
⚠️ **布尔属性名是 `BooleanOption`**（曾误写 `BooleanOperation` 编译报 CS1061）。

### 4.3 ConeBuilder（圆锥）
```
prop Expression BaseDiameter / TopDiameter / HalfAngle / Height { get; }
prop Axis Axis { get; set; }         prop SelectICurve BaseArc / TopArc { get; }
prop BooleanOperation BooleanOption { get; }   prop Types Type { get; set; }
```

### 4.4 SphereBuilder（球）
```
prop Point CenterPoint { get; set; }  ← 类型是 Point，须 Point 对象
prop Expression Diameter { get; }
prop BooleanOperation BooleanOption { get; }
prop Types Type { get; set; }
```
⚠️ `CenterPoint = work.Points.CreatePoint(new Point3d(...))`（不可直接赋 Point3d）。

### 4.5 ExtrudeBuilder（拉伸）
```
prop Section Section { get; set; }            prop Direction Direction { get; set; }
prop BooleanOperation BooleanOperation { get;} prop Limits Limits { get; }
prop FeatureOffset Offset { get; }            prop MultiDraft Draft { get; }
prop FeatureOptions FeatureOptions { get; }   prop Double DistanceTolerance/ChainingTolerance/PlanarTolerance/AngularTolerance { get; set; }
method Void SetToleranceValues(double dist, double chain, double planar, double angular)
method Void AllowSelfIntersectingSection(Boolean allow)
```

### 4.6 RevolveBuilder（旋转）
```
prop Section Section { get; set; }     prop Axis Axis { get; set; }
prop BooleanOperation BooleanOperation { get; }  prop Limits Limits { get; }
prop FeatureOffset Offset { get; }     prop FeatureOptions FeatureOptions { get; }
prop Double Tolerance { get; set; }
method Void SetStartLimitHelperPoint(Double[] pnt) / SetEndLimitHelperPoint(Double[] pnt)
```

### 4.7 CylinderGearBuilder（圆柱齿轮——真实渐开线齿形，本项目主用法）
```
prop Expression Module { get; }                 prop Expression TeethNumber { get; }
prop Expression PressureAngle { get; }          prop Expression FaceWidth { get; }
prop Expression HelixAngle { get; }             prop Expression OutsideDiameter { get; }
prop Expression PitchDiameter { get; }          prop Expression TipDiameter { get; }
prop Expression Clearance { get; }              prop Expression AddendumFactor { get; }
prop Expression AddenModCoe / CutterAddenModCoe / CutterTeethNumber /
                    MatchAddenModCoe / MatchTeethNumber / FilletRadiusFactor { get; }
prop Types Type { get; set; }                   prop EnumMachiningType MachiningType { get; set; }
prop EnumParameterType ParameterType { get; set;}prop EnumAddendumType AddendumType { get; set; }
prop EnumHandednessOfHelixType HandednessOfHelix { get; set; }
prop Axis Axis { get; set; }                    prop Boolean AssociativeAxis { get; set; }
prop BooleanOperation BooleanOperation { get; }
```
**关键用法（已实测）**：
- 创建：`work.Features.GCToolsFeatureCollection.CreateCylinderGearBuilder(null)`
- 赋值：`builder.Module.RightHandSide = "2";`（所有 Expression 均用 RightHandSide 字符串）
- **内齿圈(InternalSpur)必须 `MachiningType = EnumMachiningType.Shaping`**，否则 Commit 报 `NXException 参数无效`；外齿 Hobbing/Shaping 均可
- **定位不能用 `Axis.SetOrigin`**（智能对象报错）；正确：
```csharp
builder.Axis.Point = work.Points.CreatePoint(new Point3d(x,y,z));
builder.Axis.Direction = work.Directions.CreateDirection(new Point3d(0,0,0), new Vector3d(0,0,1), UpdateOption.WithinModeling);
```
- `Types` 枚举：`ExternalSpur=0 / ExternalHelical=1 / InternalSpur=2 / InternalHelical=3`
- `EnumMachiningType`：`Hobbing=0 / Shaping=1`
- `EnumParameterType`：`MatchingGearParameters=0 / PitchDiameterAndTipDiameter=1`
- `EnumAddendumType`：`StandardWithoutAddendum=0 / SameAddendumModification=1 / DifferentAddendumModification=2`
- `EnumHandednessOfHelixType`：`LeftHand=0 / RightHand=1`
- `Axis` 类型 `NXOpen.Axis`：`prop Point Point { get; set; }` / `prop Direction Direction { get; set; }` / `prop Vector3d DirectionVector { get; }` / `method SetOrigin(Point3d)` / `method SetDirectionVector(Vector3d)`
- **齿根圆半径**（内齿圈切内孔避让推导）：`r_root = m(Zr+2.5)/2`；壳体连接筒内孔半径须 ≥ 该值才不伤齿

### 4.8 BooleanBuilder（布尔，通用体间运算）
见第 3 节 (C)。

### 4.9 HoleFeatureBuilder（孔）
```
prop Expression Diameter / Depth / TipAngle { get; }
prop Expression CounterboreDiameter / CounterboreDepth { get; }
prop Expression CountersinkDiameter / CountersinkAngle { get; }
prop Point3d HoleLocation { get; set; }   prop ISurface PlacementFace { get; set; }
prop Boolean ReverseDirection { get; set; }   prop HoleSubtype Subtype { get; set; }
```

---

## 5. 特征管理辅助 API（也已实测）
```csharp
work.Features.GetFeatures()            -> Feature[]          // 遍历特征
work.Features.FindObject(journalId)    -> Feature            // 按 ID 找
work.Features.SuppressFeatures(Feature[])      / UnsuppressFeatures(Feature[])  // 抑制/取消抑制
feature.SetName("NewName")             // ⚠️ 命名用 SetName，属性 Name 只读
uf.Modl.AskBoundingBox(body.Tag, double[6])    // 包围盒 [minx,miny,minz,maxx,maxy,maxz]
measure.distance / model.tree          // RPC 验证手段
```

---

## 6. journal.run 使用规范

1. 宿主已注入：`theSession`、`work`(当前部件)、`uf`；方法体内**无需类/命名空间包裹**；结尾 `RESULT = sb.ToString();`
2. 输出用 `System.Text.StringBuilder`，避免超大字符串截断（有 4MB 上限）
3. 每条 write journal 自带 Undo mark（可用 session.undo 整体撤销）
4. ⚠️ **编译错误输出在 stdout**（宿主 SplitErrors 只看 stderr → 显示 compileErrors:[]），本地用 `journal_run.sh` 失败自动 csc 抓真实错误
5. ⚠️ redo 脆弱性：`session.redo` 必须紧跟 `session.undo`，中间不能穿插任何 NXOpen 调用

## 附录 A：NX 2606 全部建模特征构建 API 完整 dump（反射取证 2026-09-15）

> 全量逐签名 dump（1.2MB / 30482 行）见同目录 **nxapi-full-dump-2606.txt**（232 个工具与 928 个 Builder 全部展开）。

> 本附录含：FeatureCollection 全量入口签名、常用集合方法、全部 Builder/Feature 索引、旋转阵列精选。


### A.1 FeatureCollection —— 全部 310 个入口方法

```text
=== FeatureCollection methods (310) ===
  PatternBodyBuilder CreatePatternBodyBuilder(PatternBody combinePattern)
  Void DoLoggingToMakeFeaturesUpToDate(Feature[] features)
  GroupEdgeBuilder CreateGroupEdgeBuilder(GroupEdge groupEdge)
  GroupBodyBuilder CreateGroupBodyBuilder(GroupBody groupBody)
  ImprintObjectBuilder CreateImprintObjectBuilder(ImprintObject imprintObject)
  StepExpressionBuilder CreateStepExpressionBuilder(Expression stepExpression, Feature owningFeature)
  CMODTestFeatureBuilder CreateCmodtestFeatureBuilder(CMODTestFeature cmodtestFeature)
  IdealizeGeometryBuilder CreateIdealizeGeometryBuilder(IdealizeGeometry idealizeGeometry)
  FeatureGroup get_ActiveGroup()
  FlowBlendBuilder CreateFlowBlendBuilder(FlowBlend flowBlend)
  CustomFeatureBuilder CreateCustomFeatureBuilder(Feature customFeature)
  VarOffsetFaceBuilder CreateVarOffsetFaceBuilder(VarOffsetFace varOffsetFace)
  RenewFeatureBuilder CreateRenewFeatureBuilder()
  EditWithRollbackManager StartEditWithRollbackManager(Feature featureToEdit, UndoMarkId featureEditMark)
  TrimCurve2Builder CreateTrimCurve2FeatureBuilder(TrimCurve2 trimCurve2Feature)
  EmbedManagerBuilder CreateEmbedManagerBuilder()
  BodyByEquationBuilder CreateBodyByEquationBuilder(BodyByEquation facetBodyByEquation)
  Feature InsertNewDesignGroup(Feature referenceFeature, ReorderType relativeLocation)
  DeformDefinitionBuilder CreateDeformDefinitionBuilder()
  MoveToGroupBuilder CreateMoveToGroupBuilder()
  DesignGroupBuilder CreateDesignGroupBuilder(DesignGroup designGroup)
  MoveBodyBuilder CreateMoveBodyBuilder(MoveBody moveBody)
  RadiateFaceBuilder CreateRadiateFaceBuilder(RadiateFace radiateFace)
  ThreadBuilder CreateThreadBuilder(Thread thread)
  ResizeHoleBuilder CreateResizeHoleBuilder(ResizeHole editHole)
  AlgorithmicFeatureBuilder CreateAlgorithmicFeatureBuilder(Feature feature)
  ResizePatternBuilder CreateResizePatternBuilder(ResizePattern resizePattern)
  Void ConvertToLatestSplitAlgorithm()
  ContourRibBuilder CreateContourRibBuilder(ContourRib contourRib)
  CombinePatternBuilder CreateCombinePatternBuilder(CombinePattern combinePattern)
  CenterlineBuilder CreateCenterlineBuilder(Centerline centerlineFeature)
  ChangeFaceBuilder CreateChangeFaceBuilder(ChangeFace changeFace)
  GeneralConicBuilder CreateGeneralConicBuilder(GeneralConic generalConic)
  FitSurfaceBuilder CreateFitSurfaceBuilder(FitSurface fitSurface)
  SphericalCornerBuilder CreateSphericalCornerBuilder(SphericalCorner sphericalCorner)
  Feature GetParentFeatureOfFace(Face face)
  Feature[] GetAssociatedFeaturesOfFace(Face face)
  Feature[] GetParentFeaturesOfEdge(Edge edge)
  Feature[] GetAssociatedFeaturesOfEdge(Edge edge)
  Feature GetParentFeatureOfBody(Body body)
  Feature[] GetAssociatedFeaturesOfBody(Body body)
  SectionSurfaceBuilderEx CreateSectionSurfaceBuilderEx(SectionSurface sectionSurfaceEx)
  PatternFaceFeatureBuilder CreatePatternFaceFeatureBuilder(PatternFaceFeature patternFaceFeature)
  RenameLinkedPartModulePartBuilder CreateRenameLinkedPartModulePartBuilder()
  ConvertFeatureGroupsToModulesBuilder CreateConvertFeatureGroupsToModulesBuilder()
  ConvertFeatureGroupsToDesignGroupsBuilder CreateConvertFeatureGroupsToDesignGroupsBuilder()
  NestModuleBuilder CreateNestModuleBuilder()
  PatternGeometryBuilder CreatePatternGeometryBuilder(PatternGeometry patternGeometry)
  UnnestModuleBuilder CreateUnnestModuleBuilder()
  BlendPocketBuilder CreateBlendPocketBuilder(BlendPocket blendPocket)
  AnalyzePocketBuilder CreateAnalyzePocketBuilder(AnalyzePocket analyzePocket)
  OptimizeCurveBuilder CreateOptimizeCurveBuilder()
  Void ReorganizeFeature(Feature[] features, Feature target, ReorderType beforeOrAfter)
  Void DeleteInformationalAlerts(NXObject[] feature)
  Void DeleteWarningAlerts(NXObject[] feature)
  Void ConvertToFloatingFeatureGroups()
  Void ConvertToSequentialFeatureGroups()
  VariableOffsetBuilder CreateVariableOffsetBuilder(VariableOffset variableOffset)
  ExtensionBuilder CreateExtensionBuilder(Extension extension)
  StudioSplineBuilderEx CreateStudioSplineBuilderEx(NXObject spline)
  SketchSplineBuilder CreateSketchSplineBuilder(Spline spline)
  DraftingSplineBuilder CreateDraftingSplineBuilder(Spline spline)
  BridgeSurfaceBuilder CreateBridgeSurfaceBuilder(BridgeSurface bridgeSurface)
  EditCrossSectionBuilder CreateEditCrossSectionBuilder(EditCrossSection editCrossSection)
  LabelNotchBlendBuilder CreateLabelNotchBlendBuilder(LabelNotchBlend labelNotchBlend)
  Void SetEditWithRollbackFeature(Feature feature)
  Void SetCanResetMcf(Boolean canResetMcf)
  PartModuleBuilder CreatePartModuleBuilder(PartModule partModule)
  PartModuleRelationshipBuilder CreatePartModuleRelationshipBuilder(PartModule partModule)
  DeleteBodyBuilder CreateDeleteBodyBuilder(DeleteBody deleteBody)
  IsolateFeatureBuilder CreateIsolateFeatureBuilder(IsolateFeature isolateFeature)
  HelixBuilder CreateHelixBuilder(Helix helix)
  ColorFeatureBuilder CreateColorFeatureBuilder()
  ColorFeatureGroupBuilder CreateColorFeatureGroupBuilder()
  BridgeCurveBuilderEx CreateBridgeCurveBuilderEx(BridgeCurve bridgeCurve)
  FitCurveBuilder CreateFitCurveBuilder(FitCurve fitCurve)
  SketchFitCurveBuilder CreateSketchFitCurveBuilder(Curve fitCurve)
  EmbossBodyBuilder CreateEmbossBodyBuilder(EmbossBody embossBody)
  AestheticFaceBlendBuilder CreateAestheticFaceBlendBuilder(AestheticFaceBlend aestheticFaceBlend)
  EdgeSymmetryBuilder CreateEdgeSymmetryBuilder(Feature edgeSymmetry)
  ReplaceBlendBuilder CreateReplaceBlendBuilder(ReplaceBlend replaceBlend)
  SketchConversionReport ReplaceWithIndependentSketch(Feature[] features)
  MakeOffsetBuilder CreateMakeOffsetBuilder(MakeOffset makeOffset)
  OptimizeFaceBuilder CreateOptimizeFaceBuilder()
  ShowRelatedFacesBuilder CreateShowRelatedFacesBuilder()
  FixedBuilder CreateFixedBuilder(Fixed makeFix)
  LabelChamferBuilder CreateLabelChamferBuilder(LabelChamfer labelChamfer)
  ResizeChamferBuilder CreateResizeChamferBuilder(ResizeChamfer resizeChamfer)
  MapleBuilder CreateMapleBuilder(Maple maple)
  MathIntegrationBuilder CreateMathIntegrationBuilder(MathIntegration mathIntegration)
  ConcaveFacesBuilder CreateConcaveFacesBuilder(ConcaveFaces concaveFaces)
  VirtualCurveBuilder CreateVirtualCurveBuilder(VirtualCurve virtualCurve)
  VirtualBlendEdgeBuilder CreateVirtualBlendEdgeBuilder()
  IFormBuilder CreateIformBuilder(IForm iform)
  LawCurveBuilder CreateLawCurveBuilder(LawCurve lawCurve)
  TextBuilder CreateTextBuilder(Text text)
  DeleteEdgeBuilder CreateDeleteEdgeBuilder(DeleteEdge deleteEdge)
  CopyPasteBuilder CreateCopyPasteBuilder2(NXObject[] features)
  ReorderBlendsBuilder CreateReorderBlendsBuilder(ReorderBlends reorderBlends)
  IsoparametricCurvesBuilder CreateIsoparametricCurvesBuilder(IsoparametricCurves isoparametricCurves)
  Void ConvertToNewFeatureGroups()
  ShellFaceBuilder CreateShellFaceBuilder(ShellFace shellFace)
  ChangeShellThicknessBuilder CreateChangeShellThicknessBuilder(ChangeShellThickness shellFace)
  LinkedFacetBuilder CreateLinkedFacetBuilder(LinkedFacet linkedFacet)
  SilhouetteFlangeBuilder CreateSilhouetteFlangeBuilder(SilhouetteFlange silhouetteFlange)
  ReplaceFeatureBuilder CreateReplaceFeatureBuilder()
  PaintParametersBuilder CreatePaintParametersBuilder()
  SmoothSplineBuilder CreateSmoothSplineBuilder(SmoothSpline smoothSpline)
  SymmetricBuilder CreateSymmetricBuilder(Symmetric symmetric)
  FeatureReplayBuilder CreateFeatureReplayBuilder()
  SplitBodyBuilder CreateSplitBodyBuilder(SplitBody splitBody)
  SplitBodyBuilder CreateSplitBodyBuilderUsingCollector(SplitBody splitBody)
  TrimBody2Builder CreateTrimBody2Builder(TrimBody2 trimBody2)
  AngularDimBuilder CreateAngularDimensionBuilder(AngularDim angularDimension)
  SectionEditBuilder CreateSectionEditBuilder(SectionEdit sectionEdit)
  PullFaceBuilder CreatePullFaceBuilder(PullFace pullFace)
  MidSurfaceByFacePairsBuilder CreateMidSurfaceByFacePairsBuilder(Feature midSurfaceByFacePairs)
  MidSurfaceBuilder CreateMidSurfaceBuilder(Feature midSurface)
  MidSurfaceByTwoSheetsBuilder CreateMidSurfaceByTwoSheetsBuilder(Feature midSurfaceByTwoSheets)
  MidSurfaceUserDefinedBuilder CreateMidSurfaceUserDefinedBuilder(MidSurfaceUserDefined midsurfaceUserDefined)
  PatternFeatureBuilder CreatePatternFeatureBuilder(Feature patternFeature)
  InstanceFeatureBuilder CreateInstanceFeatureBuilder(InstanceFeature instanceFeature)
  InstanceFeatureBuilder CreateInstanceFeatureBuilder(InstanceFeature[] instanceFeatures, Boolean forClocking)
  FeatureBuilder CreateVehicleCoordinateSystemBuilder(Feature vehicleCoordinateSystem)
  StudioXformBuilderEx CreateStudioXformBuilderEx(StudioXform studioXform1)
  SweepAlongGuideBuilder CreateSweepAlongGuideBuilder(SweepAlongGuide sweepAlongGuide)
  ParallelBuilder CreateParallelBuilder(Parallel parallel)
  CoaxialBuilder CreateCoaxialBuilder(Coaxial coaxial)
  PerpendicularBuilder CreatePerpendicularBuilder(Perpendicular perpendicular)
  TangentBuilder CreateTangentBuilder(Tangent tangent)
  AdmResizeFaceBuilder CreateAdmResizeFaceBuilder(AdmResizeFace admResizeFace)
  StyledCornerBuilder CreateStyledCornerBuilder(StyledCorner styledCorner)
  AdmOffsetRegionBuilder CreateAdmOffsetRegionBuilder(AdmOffsetRegion offsetRegion)
  MirrorFaceBuilder CreateMirrorFaceBuilder(Feature mirrorFace)
  PointSetBuilder CreatePointSetBuilder(PointSet pointSet)
  FeatureBuilder CreateWindshieldDatumBuilder(Feature windshieldDatum)
  FeatureBuilder CreateVisionPlaneBuilder(Feature visionPlane)
  FeatureBuilder CreateHoodVisibilityBuilder(Feature hoodVisibility)
  FeatureBuilder CreatePedestrianProtectionBuilder(Feature pedestrianProtection)
  Void SuspendModelDelayBeforeReorder()
  Void ReorderFeature(Feature[] features, Feature target, ReorderType beforeOrAfter)
  Void RestoreModelDelayAfterReorder()
  MirrorCurveBuilder CreateMirrorCurveBuilder(Feature mirrorCurve)
  PromotionBuilder CreatePromotionBuilder(Promotion promotion)
  RefitFaceBuilder CreateRefitFaceBuilder(RefitFace refitFace)
  EditDimensionBuilder CreateEditDimensionBuilder()
  AdaptiveShellBuilder CreateAdaptiveShellBuilder(AdaptiveShell shellFace)
  MeshTransformerBuilder CreateMeshTransformerBuilder(Feature meshTransformer)
  CombinedProjectionBuilder CreateCombinedProjectionBuilder(CombinedProjection combinedProjection)
  StyledSweepBuilder CreateStyledSweepBuilder(Feature styledSweep)
  CutFaceBuilder CreateCutFaceBuilder(Feature cutFace)
  ConeBuilder CreateConeBuilder(Cone cone)
  SphereBuilder CreateSphereBuilder(Sphere sphere)
  CopyFaceBuilder CreateCopyFaceBuilder(Feature copyFace)
  PasteFaceBuilder CreatePasteFaceBuilder(Feature pasteFace)
  PoleSmoothingBuilder CreatePoleSmoothingBuilder(PoleSmoothing poleSmoothing)
  AdmMoveFaceBuilder CreateAdmMoveFaceBuilder(AdmMoveFace admMoveFace)
  WrapGeometryBuilder CreateWrapGeometryBuilder(WrapGeometry wrapGeometry)
  GroupFaceBuilder CreateGroupFaceBuilder(GroupFace groupFace)
  ColorFaceBuilder CreateColorFaceBuilder()
  FeatureBuilder CreateSeatBeltAnchorageBuilder(Feature seatBeltAnchorage)
  BoundedPlaneBuilder CreateBoundedPlaneBuilder(BoundedPlane boundedPlane)
  AssemblyCutBuilder CreateAssemblyCutBuilder(AssemblyCut assemblyCut)
  FeatureBuilder CreateReflectionDataBuilder(Feature reflectionData)
  WrapBuilder CreateWrapBuilder(WrapUnwrap wrap)
  RemoveParametersBuilder CreateRemoveParametersBuilder()
  MatchEdgeBuilder CreateMatchEdgeBuilder(MatchEdge matchEdge)
  RadialDimensionBuilder CreateRadialDimensionBuilder(RadialDimension radialDimension)
  StyledBlendBuilder CreateStyledBlendBuilder(StyledBlend styledBlend)
  HolePackageBuilder CreateHolePackageBuilder(HolePackage holePackage)
  ThroughCurvesBuilder CreateThroughCurvesBuilder(Feature throughCurves)
  StudioSurfaceBuilder CreateStudioSurfaceBuilder(Feature studioSurface)
  SectionInertiaAnalysisBuilder CreateSectionInertiaAnalysisBuilder(SectionInertiaAnalysis sectionInertiaAnalysis)
  Boolean GetIsMasterCutVisibleInView(Feature masterCut, CutView view)
  DeleteFaceBuilder CreateDeleteFaceBuilder(Feature deleteFace)
  ResizeBlendBuilder CreateResizeBlendBuilder(Feature resizeBlend)
  PatchOpeningsBuilder CreatePatchOpeningsBuilder(Feature patchOpenings)
  MoveFaceBuilder CreateMoveFaceBuilder(Feature moveFace)
  OffsetRegionBuilder CreateOffsetRegionBuilder(Feature offsetRegion)
  PatternFaceBuilder CreatePatternFaceBuilder(Feature patternFace)
  ResizeFaceBuilder CreateResizeFaceBuilder(Feature resizeFace)
  ReplaceFaceBuilder CreateReplaceFaceBuilder(Feature replaceFace)
  RuledBuilder CreateRuledBuilder(Feature ruled)
  NSidedSurfaceBuilder CreateNSidedSurfaceBuilder(NSidedSurface nsidedSurface)
  SectionSurfaceBuilder CreateSectionSurfaceBuilder(SectionSurface sectionSurface)
  CoplanarBuilder CreateCoplanarBuilder(Feature coplanar)
  SnipSurfaceBuilder CreateSnipSurfaceBuilder(SnipSurface snipSurface)
  LinearDimensionBuilder CreateLinearDimensionBuilder(LinearDimension linearDimension)
  EnlargeBuilder CreateEnlargeBuilder(Enlarge enlargeFeature)
  LawExtensionBuilder CreateLawExtensionBuilder(LawExtension lawExtension)
  LawExtensionBuilderEx CreateLawExtensionBuilderEx(Feature lawExtension)
  GuidedExtensionBuilderEx CreateGuidedExtensionBuilderEx(Feature guidedExtension)
  FreeTransformerBuilder CreateFreeTransformerBuilder(Feature freeTransformer)
  WaveSketchBuilder CreateWaveSketchBuilder(Feature wavesketch)
  WaveRoutingBuilder CreateWaveRoutingBuilder(Feature waverouting)
  WavePointBuilder CreateWavePointBuilder(Feature wavepoint)
  CompositeCurveBuilder CreateCompositeCurveBuilder(Feature compositeCurve)
  ExtractFaceBuilder CreateExtractFaceBuilder(Feature copyFace)
  MirrorBodyBuilder CreateMirrorBodyBuilder(Feature mirrorBody)
  LinkLargeScaleGeometryBuilder CreateLinkLargeScaleGeometryBuilder(LinkLargeScaleGeometry linkLargeScaleGeometry)
  TrimSheetBuilder CreateTrimsheetBuilder(Feature trimSheet)
  CircularBlendCurveBuilder CreateCircularBlendCurveBuilder(CircularBlendCurve circularBlendCurve)
  RapidSurfaceBuilder CreateRapidSurfaceBuilder(RapidSurface rapidSurface)
  UnsewBuilder CreateUnsewBuilder(Unsew unsew)
  DraftBodyBuilder CreateDraftBodyBuilder(Feature draftBody)
  Feature[] GetPartFeaturesWithNewAlerts()
  Feature[] GetAllPartFeaturesWithAlerts()
  GlobalShapingBuilder CreateGlobalShapingBuilder(GlobalShaping globalShaping)
  TrimCurveBuilder CreateTrimCurveBuilder(TrimCurve trimCurve)
  TrimCurveBuilder CreateTrimCurveBuilder(Spline trimCurve)
  OffsetCurveBuilder CreateOffsetCurveBuilder(Feature offsetCurve)
  Void DeleteAllPartInformationalFeatureAlerts()
  ThroughCurveMeshBuilder CreateThroughCurveMeshBuilder(Feature throughCurveMesh)
  BridgeCurveBuilder CreateBridgeCurveBuilder(Feature bridgeCurve)
  SweptBuilder CreateSweptBuilder(Swept swept)
  CylinderBuilder CreateCylinderBuilder(Feature cylinder)
  ShellBuilder CreateShellBuilder(Feature shell)
  DatumCsysBuilder CreateDatumCsysBuilder(Feature datumCsys)
  DraftBuilder CreateDraftBuilder(Feature draft)
  RasterImage CreateRasterImage(Point3d origin, Matrix3x3 matrix, Double length, Double height, String imageFileName, Double translucency, MaxTextureSize maximumTextureSize)
  MasterCutBuilder CreateMasterCutBuilder(Feature masterCut)
  AOCSBuilder CreateAocsBuilder(Feature aocs)
  OffsetFaceBuilder CreateOffsetFaceBuilder(Feature offsetface)
  TubeBuilder CreateTubeBuilder(Feature tube)
  MirrorFeatureBuilder CreateMirrorFeatureBuilder(Feature mirrorFea)
  MirrorBuilder CreateMirrorBuilder(Mirror mirrorFeature)
  ScaleBuilder CreateScaleBuilder(Feature scale)
  SewBuilder CreateSewBuilder(Feature sew)
  SectionCurveBuilder CreateSectionCurveBuilder(Feature sectionCurves)
  IntersectionCurveBuilder CreateIntersectionCurveBuilder(Feature intersectionCurve)
  ThickenBuilder CreateThickenBuilder(Feature thicken)
  TrimExtendBuilder CreateTrimExtendBuilder(Feature trimExtend)
  GeomcopyBuilder CreateGeomcopyBuilder(Feature geomcopy)
  ProjectCurveBuilder CreateProjectCurveBuilder(Feature projectCurve)
  JoinCurvesBuilder CreateJoinCurvesBuilder(Feature joinCurves)
  StudioSplineBuilder CreateStudioSplineBuilder(StudioSpline splineFeature)
  CurveOnSurfaceBuilder CreateCurveOnSurfaceBuilder(CurveOnSurface cosFeature)
  UntrimBuilder CreateUntrimBuilder(Feature untrim)
  WaveDatumBuilder CreateWaveDatumBuilder(Feature wavedatum)
  RPOBuilder CreateRpoBuilder(Feature rpo)
  ChamferBuilder CreateChamferBuilder(Feature chamfer)
  EdgeBlendBuilder CreateEdgeBlendBuilder(Feature edgeblend)
  BooleanFeature[] CreateUniteFeature(Body targetBody, Boolean retainTargetBody, Body[] toolBodies, Boolean retainToolBodies, Boolean allowNonAssociativeBoolean, Boolean& nonAssociativeBoolean, Boolean& unparameterizedSolids)
  BooleanFeature[] CreateSubtractFeature(Body targetBody, Boolean retainTargetBody, Body[] toolBodies, Boolean retainToolBodies, Boolean allowNonAssociativeBoolean, Boolean& nonAssociativeBoolean, Boolean& unparameterizedSolids)
  BooleanFeature[] CreateIntersectFeature(Body targetBody, Boolean retainTargetBody, Body[] toolBodies, Boolean retainToolBodies, Boolean allowNonAssociativeBoolean, Boolean& nonAssociativeBoolean, Boolean& unparameterizedSolids)
  VarsweepBuilder CreateVarsweepBuilder(Feature varsweep)
  FaceBlendBuilder CreateFaceBlendBuilder(Feature faceBlend)
  Feature[] GetFeatures()
  Feature FindObject(String journalIdentifier)
  Void SuppressFeatures(Feature[] features)
  Feature[] UnsuppressFeatures(Feature[] features)
  ErrorList CreateSnapshotsOfFeatures(Feature[] features)
  Void DeleteSnapshot(Feature feature)
  Feature GetAssociatedFeature(NXObject object)
  HumanBuilder CreateHumanBuilder(Feature human)
  HumanPosturePredictionBuilder CreateHumanPosturePredictionBuilder(HumanPosturePrediction posturePrediction)
  OffsetSurfaceBuilder CreateOffsetSurfaceBuilder(Feature offsetSurface)
  RibbonBuilder CreateRibbonBuilder(Feature ribbon)
  PatchBuilder CreatePatchBuilder(Feature patch)
  BooleanBuilder CreateBooleanBuilder(BooleanFeature booleanFeature)
  BooleanBuilder CreateBooleanBuilderUsingCollector(BooleanFeature booleanFeature)
  TrimBodyBuilder CreateTrimBodyBuilder(Feature trimbodyFeat)
  Feature[] ToArray()
  Tag get_Tag()
  SheetmetalManager get_SheetmetalManager()
  AeroSheetmetalManager get_AeroSheetmetalManager()
  DieCollection get_Dies()
  WeldManager get_WeldManager()
  AutomotiveCollection get_AutomotiveCollection()
  ShipCollection get_ShipCollection()
  ToolingCollection get_ToolingCollection()
  SynchronousEdgeCollection get_SynchronousEdgeCollection()
  SweepFeatureCollection get_SweepFeatureCollection()
  SynchronousCurveCollection get_SynchronousCurveCollection()
  VehicleDesignCollection get_VehicleDesignCollection()
  DesignFeatureCollection get_DesignFeatureCollection()
  FreeformCurveCollection get_FreeformCurveCollection()
  FreeformSurfaceCollection get_FreeformSurfaceCollection()
  TrimFeatureCollection get_TrimFeatureCollection()
  ToolingFeatureCollection get_ToolingFeatureCollection()
  CustomAttributeCollection get_CustomAttributeCollection()
  AeroCollection get_AeroCollection()
  CurveFeatureCollection get_CurveFeatureCollection()
  GeodesicSketchCollection get_GeodesicSketchCollection()
  CustomFeatureDataCollection get_CustomFeatureDataCollection()
  LatticeFeatureCollection get_LatticeFeatureCollection()
  PrintCsysFeatureCollection get_PrintCsysFeatureCollection()
  DetailFeatureCollection get_DetailFeatureCollection()
  MorphMeshCollection get_MorphMeshCollection()
  StructureDesignCollection get_StructureDesignCollection()
  AECDesignCollection get_AECDesignCollection()
  GCToolsFeatureCollection get_GCToolsFeatureCollection()
  AVDACollection get_AVDACollection()
  AirRegionCollection get_AirRegionCollection()
  MeshSurfaceBuilder CreateMeshSurfaceBuilder(Feature meshSurf)
  BlockFeatureBuilder CreateBlockFeatureBuilder(Feature block)
  CopyPasteBuilder CreateCopyPasteBuilder(NXObject[] features)
  ReferenceMapperBuilder CreateReferenceMapperBuilder(FeatureBuilder booleanBuilderTag)
  ExtrudeBuilder CreateExtrudeBuilder(Feature extrude)
  UserDefinedObjectFeatureBuilder CreateUserDefinedObjectFeatureBuilder(Feature udoFeature)
  RevolveBuilder CreateRevolveBuilder(Feature revolve)
  EmbossBuilder CreateEmbossBuilder(Feature emboss)
  OffsetEmbossBuilder CreateOffsetEmbossBuilder(Feature offsetEmboss)
  DividefaceBuilder CreateDividefaceBuilder(Feature divideface)
  OvercrownBuilder CreateOvercrownFeatureBuilder(Feature overcrown)
  CurveLengthBuilder CreateCurvelengthBuilder(Feature curvelength)
  DatumAxisBuilder CreateDatumAxisBuilder(Feature datumAxis)
  DatumPlaneBuilder CreateDatumPlaneBuilder(Feature dplane)
  ResizePlaneBuilder CreateResizePlaneBuilder(Feature resizePlane)
  HoleFeatureBuilder CreateHoleFeatureBuilder(Feature hole)
```

### A.1.2 集合 Directions 方法

```text
=== Points (PointCollection) methods: 45 ===
  Point CreateVirtualIntersectionPoint(IBaseCurve curve1, IBaseCurve curve2, Point helpPt1, Point helpPt2, UpdateOption updateOption)
  Point CreatePoint(Expression exp, UpdateOption updateOption)
  Point CreateStockOffsetPoint(Point basePoint, Direction offsetDirr, String offsetExpression, UpdateOption updateOption)
  Point EditStockOffsetPoint(Point basePoint, Direction offsetDirr, String offsetExpression, UpdateOption updateOption)
  Point CreatePointOnPortExtractAlign(UpdateOption updateOption, Port port, Scalar distance)
  Point CreatePointOnSurfaceAxis(TaggedObject face, Scalar parameter, UpdateOption updateOption)
  Point CreatePoint(CAEFace face, Point projectedPoint, UpdateOption updateOption)
  Point CreateQuadrantPoint(IBaseCurve curveOrEdge, Int32 quadrant, UpdateOption updateOption)
  Point CreatePointOnSectionCG(UpdateOption updateOption, TaggedObject face)
  Void DeletePoint(Point point)
  Void RemoveParameters(Point point)
  Point CreatePoint(ScCollector faces, IBaseCurve curve, Point helpPt1, Point helpPt2, UpdateOption updateOption)
  Point CreatePoint(UpdateOption updateOption, Annotation annotation, Scalar t, Int32 side, Int32 block, Boolean attachFcfToDim)
  Point CreatePoint(IBaseCurve splarc, View view)
  Point CreatePointSplinePole(IBaseCurve splineCurve, Int32 poleIndex, UpdateOption updateOption)
  Point CreatePointSplarc(IBaseCurve splarc, View view)
  Point CreatePointSplineDefiningPoint(IBaseCurve splineCurve, Int32 definingPointIndex, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve edgeCurve, Scalar scalarT, PointOnCurveLocationOption locationOption, Point specifiedPoint, UpdateOption updateOption)
  Point CreatePointAtCoordinateSystemOrigin(UpdateOption updateOption, CoordinateSystem smartCsys)
  Point CreatePointBSurfacePole(IParameterizedSurface face, Int32 uIndex, Int32 vIndex, UpdateOption updateOption)
  Point CreateCurveMidPoint(IBaseCurve curve, UpdateOption updateOption)
  Point CreatePointFromShipCoordinates(UpdateOption updateOption, IBasePlane xPlane, IBasePlane yPlane, IBasePlane zPlane, ShipCoordinatesXdirectiontype xDirection, ShipCoordinatesYdirectiontype yDirection, ShipCoordinatesZdirectiontype zDirection, Scalar xDistance, Scalar yDistance, Scalar zDistance)
  Point[] ToArray()
  Tag get_Tag()
  Point CreatePoint(Point3d coordinates)
  Point CreatePoint(Offset offset, Point offsetPoint, UpdateOption updateOption)
  Point CreatePoint(IParameterizedSurface face, Scalar scalarU, Scalar scalarV, UpdateOption updateOption)
  Point CreatePoint(View view, IBaseCurve edgeCurve1, IBaseCurve edgeCurve2, Point3d helpPt, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve edgeCurve, Scalar scalarT, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve edgeCurve, Scalar scalarT, PointOnCurveLocationOption locationOption, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve edgeCurve, Scalar scalarT, UpdateOption updateOption, Boolean useReverseParameter)
  Point CreatePoint(IBaseCurve edgeCurve, Point pointOffset, Scalar distancePercent, AlongCurveOption option, Sense sense, UpdateOption updateOption)
  Point CreatePoint(Scalar scalarX, Scalar scalarY, Scalar scalarZ, UpdateOption updateOption)
  Point CreatePoint(Point pointExtract, Xform xform, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve edgeCurve, Scalar angle, Xform xform, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve edgeCurve, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve curve1, IBaseCurve curve2, Point helpPt1, Point helpPt2, UpdateOption updateOption)
  Point CreatePoint(IBaseCurve curve1, IBaseCurve curve2, Point3d startPoint, View view, UpdateOption updateOption)
  Point CreatePoint(IParameterizedSurface face, IBaseCurve curve, Point helpPt1, Point helpPt2, UpdateOption updateOption)
  Point CreatePoint(IBasePlane plane, IBaseCurve curve, Point helpPt1, Point helpPt2, UpdateOption updateOption)
  Point CreatePoint(IParameterizedSurface sphericalFace, UpdateOption updateOption)
  Point CreatePoint(IRoutePosition routePosition, Xform xform, UpdateOption updateOption)
  Point FindObject(String journalIdentifier)
  Point CreatePoint(CartesianCoordinateSystem csys, Scalar scalarX, Scalar scalarY, Scalar scalarZ, UpdateOption updateOption)
  Point CreatePoint(Point point1, Point point2, Scalar distancePercentage, UpdateOption updateOption)
```

### A.1.3 集合 Bodies 方法

```text
=== Directions (DirectionCollection) methods: 33 ===
  Direction CreateDirection(Port port, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Direction direction1, Direction direction2, UpdateOption updateOption)
  Direction CreateDirection(Point point, Expression exp, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(IParameterizedSurface face, Point point, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(ScCollector faces, Point point, Sense sense, UpdateOption updateOption)
  Direction CreateDumbDirectionFace(IParameterizedSurface face, Sense sense, UpdateOption updateOption)
  Direction CreateDumbDirectionFaceAtPoint(IParameterizedSurface face, Point point, Sense sense, UpdateOption updateOption)
  Direction CreateDumbDirectionOnCurveAtPoint(IBaseCurve icurve, Point point, OnCurveOption option, Sense sense, UpdateOption updateOption)
  Direction CreateDumbDirectionAxisOfConic(IBaseCurve conic, Sense sense, UpdateOption updateOption)
  Direction CreateDumbDirectionFacesAtPoint(ScCollector faces, Point point, Sense sense, UpdateOption updateOption)
  Direction[] ToArray()
  Tag get_Tag()
  Direction CreateDirection(Point3d origin, Vector3d vector, UpdateOption update)
  Direction CreateDirection(Line line, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(IBaseCurve edge, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(DatumAxis datumAxis, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(ControlPoint startPoint, ControlPoint endPoint, UpdateOption updateOption)
  Direction CreateDirection(Point startPoint, Point endPoint, UpdateOption updateOption)
  Direction CreateDirection(IParameterizedSurface face, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(IBasePlane plane, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Sketch plane, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Conic conic, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(IBaseCurve icurve, Scalar t, OnCurveOption option, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(IBaseCurve icurve, Point point, OnCurveOption option, Sense sense, UpdateOption updateOption)
  Direction CreateDirectionOnPointParentCurve(Point atPoint, IBaseCurve curve, OnCurveOption option, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Face face, Scalar u, Scalar v, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Face face, Scalar u, Scalar v, Boolean absoluteUv, OnFaceOption option, Direction sectionDirection, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Face face, Scalar u, Scalar v, Boolean absoluteUv, Scalar sectionAngle, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Point atPoint, Face face, OnFaceOption option, SmartObject sectionDirection, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Direction directionExtract, Xform xform, UpdateOption updateOption)
  Direction CreateDirection(Point point, Vector3d vector)
  Direction CreateDirection(Face geomObj, Point point, Sense sense, UpdateOption updateOption)
  Direction CreateDirection(Direction direction, UpdateOption updateOption)
```

### A.1.4 集合 Planes 方法

```text
=== Bodies (BodyCollection) methods: 6 ===
  Body[] ToArray()
  Tag get_Tag()
  Body FindObject(String journalIdentifier)
  FourPointSurfaceBuilder CreateFourPointSurfaceBuilder()
  SurfaceUVDirectionBuilder CreateSurfaceUvdirectionBuilder()
  Void CollectionSweepabilityCheck(Boolean setColor)
```

### A.2 全部 Builder 类型索引（共 1035 个，签名见 nxapi-full-dump-2606.txt）

```text
#### NXOpen.Features.AdaptiveShellBuilder
#### NXOpen.Features.ADASCoordinateSystemBuilder
#### NXOpen.Features.AdmBaseBuilder
#### NXOpen.Features.AdmMoveFaceBuilder
#### NXOpen.Features.AdmOffsetRegionBuilder
#### NXOpen.Features.AdmResizeFaceBuilder
#### NXOpen.Features.AeroFlangeBuilder
#### NXOpen.Features.AeroRibBuilder
#### NXOpen.Features.AestheticFaceBlendBuilder
#### NXOpen.Features.AlgorithmicFeatureBuilder
#### NXOpen.Features.AnalyzePocketBuilder
#### NXOpen.Features.AngularDimBuilder
#### NXOpen.Features.AOCSBuilder
#### NXOpen.Features.ApexRangeChamferBuilder
#### NXOpen.Features.AssemblyCutBuilder
#### NXOpen.Features.AssociativeArcBuilder
#### NXOpen.Features.AssociativeLineBuilder
#### NXOpen.Features.BevelGearBuilder
#### NXOpen.Features.BlendCornerBuilder
#### NXOpen.Features.BlendCurveOnSurfaceBuilder
#### NXOpen.Features.BlendPocketBuilder
#### NXOpen.Features.BlockFeatureBuilder
#### NXOpen.Features.BodyByEquationBuilder
#### NXOpen.Features.BodyLattice2Builder
#### NXOpen.Features.BodyLatticeBuilder
#### NXOpen.Features.BooleanBuilder
#### NXOpen.Features.BoundedPlaneBuilder
#### NXOpen.Features.BridgeCurveBuilder
#### NXOpen.Features.BridgeSurfaceBuilder
#### NXOpen.Features.CenterlineBuilder
#### NXOpen.Features.ChamferBuilder
#### NXOpen.Features.ChangeFaceBuilder
#### NXOpen.Features.ChangeShellThicknessBuilder
#### NXOpen.Features.CircularBlendCurveBuilder
#### NXOpen.Features.ClipLattice2Builder
#### NXOpen.Features.ClipLatticeBuilder
#### NXOpen.Features.CMODTestFeatureBuilder
#### NXOpen.Features.CoaxialBuilder
#### NXOpen.Features.ColorFaceBuilder
#### NXOpen.Features.ColorFeatureBuilder
#### NXOpen.Features.ColorFeatureGroupBuilder
#### NXOpen.Features.CombinedProjectionBuilder
#### NXOpen.Features.CombinePatternBuilder
#### NXOpen.Features.CombineSheetsBuilder
#### NXOpen.Features.CompositeCurveBuilder
#### NXOpen.Features.ConcaveFacesBuilder
#### NXOpen.Features.ConeBuilder
#### NXOpen.Features.ConnectDanglingRodsBuilder
#### NXOpen.Features.ConnectLattices2Builder
#### NXOpen.Features.ConnectLattices3Builder
#### NXOpen.Features.ContourRibBuilder
#### NXOpen.Features.ConvertToNxLatticeBuilder
#### NXOpen.Features.CoplanarBuilder
#### NXOpen.Features.CopyFaceBuilder
#### NXOpen.Features.CopyPasteBuilder
#### NXOpen.Features.CurveFinderBuilder
#### NXOpen.Features.CurveLengthBuilder
#### NXOpen.Features.CurveOnSurfaceBuilder
#### NXOpen.Features.CustomFeatureBuilder
#### NXOpen.Features.CutFaceBuilder
#### NXOpen.Features.CylinderBuilder
#### NXOpen.Features.CylinderGearBuilder
#### NXOpen.Features.DatumAxisBuilder
#### NXOpen.Features.DatumBuilder
#### NXOpen.Features.DatumCsysBuilder
#### NXOpen.Features.DatumPlaneBuilder
#### NXOpen.Features.DeformDefinitionBuilder
#### NXOpen.Features.DeleteBodyBuilder
#### NXOpen.Features.DeleteCurveBuilder
#### NXOpen.Features.DeleteEdgeBuilder
#### NXOpen.Features.DeleteFaceBuilder
#### NXOpen.Features.DesignGroupBuilder
#### NXOpen.Features.DimensionBuilder
#### NXOpen.Features.DirectVisionBuilder
#### NXOpen.Features.DivideCurveBuilder
#### NXOpen.Features.DividefaceBuilder
#### NXOpen.Features.DraftBodyBuilder
#### NXOpen.Features.DraftBuilder
#### NXOpen.Features.DraftingSplineBuilder
#### NXOpen.Features.EdgeBlendBuilder
#### NXOpen.Features.EdgeSymmetryBuilder
#### NXOpen.Features.EditCrossSectionBuilder
#### NXOpen.Features.EditDimensionBuilder
#### NXOpen.Features.EmbeddedOperationBuilder
#### NXOpen.Features.EmbedManagerBuilder
#### NXOpen.Features.EmbossBodyBuilder
#### NXOpen.Features.EmbossBuilder
#### NXOpen.Features.EngageGearBuilder
#### NXOpen.Features.EnlargeBuilder
#### NXOpen.Features.EnvironmentPaintingBuilder
#### NXOpen.Features.ExtendSheetBuilder
#### NXOpen.Features.ExtensionBuilder
#### NXOpen.Features.ExtractFaceBuilder
#### NXOpen.Features.ExtractGraphBuilder
#### NXOpen.Features.ExtrudeBuilder
#### NXOpen.Features.FaceBlendBuilder
#### NXOpen.Features.FaceRecognitionBuilder
#### NXOpen.Features.FeatureBuilder
#### NXOpen.Features.FeatureReferencesBuilder
#### NXOpen.Features.FeatureReplayBuilder
#### NXOpen.Features.FillHoleBuilder
#### NXOpen.Features.FilterLattice2Builder
#### NXOpen.Features.FilterLattice3Builder
#### NXOpen.Features.FitCurveBuilder
#### NXOpen.Features.FitSurfaceBuilder
#### NXOpen.Features.FixedBuilder
#### NXOpen.Features.FlowBlendBuilder
#### NXOpen.Features.FreeTransformerBuilder
#### NXOpen.Features.GeneralConicBuilder
#### NXOpen.Features.GeodesicChamferBuilder
#### NXOpen.Features.GeodesicFilletBuilder
#### NXOpen.Features.GeodesicIntersectBuilder
#### NXOpen.Features.GeodesicLineBuilder
#### NXOpen.Features.GeodesicOffsetBuilder
#### NXOpen.Features.GeodesicPointBuilder
#### NXOpen.Features.GeodesicProjectBuilder
#### NXOpen.Features.GeodesicResetBuilder
#### NXOpen.Features.GeodesicSketchBuilder
#### NXOpen.Features.GeodesicTrimBuilder
#### NXOpen.Features.GeomcopyBuilder
#### NXOpen.Features.GlobalShapingBuilder
#### NXOpen.Features.GlobalShapingCurveOffsetBuilder
#### NXOpen.Features.GlobalShapingPointOffsetBuilder
#### NXOpen.Features.GridTargetBuilder
#### NXOpen.Features.GroupBodyBuilder
#### NXOpen.Features.GroupEdgeBuilder
#### NXOpen.Features.GroupFaceBuilder
#### NXOpen.Features.HealSurfaceBuilder
#### NXOpen.Features.HelixBuilder
#### NXOpen.Features.HoleFeatureBuilder
#### NXOpen.Features.HolePackageBuilder
#### NXOpen.Features.HumanBuilder
#### NXOpen.Features.IdealizeGeometryBuilder
#### NXOpen.Features.IFormBuilder
#### NXOpen.Features.ImportExportXMLBuilder
#### NXOpen.Features.ImprintObjectBuilder
#### NXOpen.Features.InstanceFeatureBuilder
#### NXOpen.Features.InterceptionBuilder
#### NXOpen.Features.InterceptionCameraListItemBuilder
#### NXOpen.Features.InterceptionMirrorListItemBuilder
#### NXOpen.Features.IntersectionCurveBuilder
#### NXOpen.Features.IsoclineCurveBuilder
#### NXOpen.Features.IsolateFeatureBuilder
#### NXOpen.Features.IsoparametricCurvesBuilder
#### NXOpen.Features.JoinCurvesBuilder
#### NXOpen.Features.LabelChamferBuilder
#### NXOpen.Features.LabelNotchBlendBuilder
#### NXOpen.Features.Lattice2Builder
#### NXOpen.Features.Lattice3Builder
#### NXOpen.Features.LawCurveBuilder
#### NXOpen.Features.LawExtensionBuilder
#### NXOpen.Features.LinearDimensionBuilder
#### NXOpen.Features.LinkedFacetBuilder
#### NXOpen.Features.LinkLargeScaleGeometryBuilder
#### NXOpen.Features.LocalScaleCurveBuilder
#### NXOpen.Features.MakeOffsetBuilder
#### NXOpen.Features.MakeRuledBuilder
#### NXOpen.Features.MakeSolidBuilder
#### NXOpen.Features.ManufacturingAllowanceBuilder
#### NXOpen.Features.MapleBuilder
#### NXOpen.Features.MasterCutBuilder
#### NXOpen.Features.MatchEdgeBuilder
#### NXOpen.Features.MatchedReferenceBuilder
#### NXOpen.Features.MathIntegrationBuilder
#### NXOpen.Features.MeshSurfaceBuilder
#### NXOpen.Features.MeshTransformerBuilder
#### NXOpen.Features.MidSurfaceBuilder
#### NXOpen.Features.MidSurfaceByFacePairsBuilder
#### NXOpen.Features.MidSurfaceByTwoSheetsBuilder
#### NXOpen.Features.MidSurfaceUserDefinedBuilder
#### NXOpen.Features.MirrorBodyBuilder
#### NXOpen.Features.MirrorBuilder
#### NXOpen.Features.MirrorCurveBuilder
#### NXOpen.Features.MirrorFaceBuilder
#### NXOpen.Features.MirrorFeatureBuilder
#### NXOpen.Features.MorphMeshBuilder
#### NXOpen.Features.MorphMeshCageBuilder
#### NXOpen.Features.MorphMeshConstraintBuilder
#### NXOpen.Features.MorphMeshDeleteConstraintBuilder
#### NXOpen.Features.MorphMeshSymmetricCageBuilder
#### NXOpen.Features.MorphMeshTransformBuilder
#### NXOpen.Features.MoveBodyBuilder
#### NXOpen.Features.MoveCurveBuilder
#### NXOpen.Features.MoveEdgeBuilder
#### NXOpen.Features.MoveFaceBuilder
#### NXOpen.Features.MoveObjectBuilder
#### NXOpen.Features.NSidedSurfaceBuilder
#### NXOpen.Features.ObstructionBuilder
#### NXOpen.Features.Offset3DCurveBuilder
#### NXOpen.Features.OffsetCurveBuilder
#### NXOpen.Features.OffsetEdgeBuilder
#### NXOpen.Features.OffsetEmbossBuilder
#### NXOpen.Features.OffsetFaceBuilder
#### NXOpen.Features.OffsetFacetBodyBuilder
#### NXOpen.Features.OffsetMoveCurveBuilder
#### NXOpen.Features.OffsetRegionBuilder
#### NXOpen.Features.OffsetSurfaceBuilder
#### NXOpen.Features.OptimizeCurveBuilder
#### NXOpen.Features.OptimizeFaceBuilder
#### NXOpen.Features.OvercrownBuilder
#### NXOpen.Features.PaintParametersBuilder
#### NXOpen.Features.ParallelBuilder
#### NXOpen.Features.PartGeometryCopyBuilder
#### NXOpen.Features.PartGeometryCopySelectBuilder
#### NXOpen.Features.PartModuleBuilder
#### NXOpen.Features.PasteFaceBuilder
#### NXOpen.Features.PatchBuilder
#### NXOpen.Features.PatchOpeningsBuilder
#### NXOpen.Features.PatternBodyBuilder
#### NXOpen.Features.PatternFaceBuilder
#### NXOpen.Features.PatternFaceFeatureBuilder
#### NXOpen.Features.PatternFeatureBuilder
#### NXOpen.Features.PatternGeometryBuilder
#### NXOpen.Features.PerpendicularBuilder
#### NXOpen.Features.PointFeatureBuilder
#### NXOpen.Features.PointSetBuilder
#### NXOpen.Features.PointSetFacePercentageBuilder
#### NXOpen.Features.PoleSmoothingBuilder
#### NXOpen.Features.PolylineBuilder
#### NXOpen.Features.PrintCsysBuilder
#### NXOpen.Features.ProjectCurveBuilder
#### NXOpen.Features.PromotionBuilder
#### NXOpen.Features.PullFaceBuilder
#### NXOpen.Features.PunchThroughBuilder
#### NXOpen.Features.RackBuilder
#### NXOpen.Features.RadialDimensionBuilder
#### NXOpen.Features.RadiateFaceBuilder
#### NXOpen.Features.RapidSurfaceBuilder
#### NXOpen.Features.ReferenceMapperBuilder
#### NXOpen.Features.RefitFaceBuilder
#### NXOpen.Features.RegionListItemBuilder
#### NXOpen.Features.RemoveParametersBuilder
#### NXOpen.Features.ReorderBlendsBuilder
#### NXOpen.Features.ReplaceBlendBuilder
#### NXOpen.Features.ReplaceFaceBuilder
#### NXOpen.Features.ReplaceFeatureBuilder
#### NXOpen.Features.ResizeBlendBuilder
#### NXOpen.Features.ResizeChamferBuilder
#### NXOpen.Features.ResizeChamferCurveBuilder
#### NXOpen.Features.ResizeCurveBuilder
#### NXOpen.Features.ResizeFaceBuilder
#### NXOpen.Features.ResizeHoleBuilder
#### NXOpen.Features.ResizePatternBuilder
#### NXOpen.Features.ResizePlaneBuilder
#### NXOpen.Features.RevolveBuilder
#### NXOpen.Features.RevolveOutlineBuilder
#### NXOpen.Features.RibbonBuilder
#### NXOpen.Features.RibBuilder
#### NXOpen.Features.RodThickness2Builder
#### NXOpen.Features.RodThicknessBuilder
#### NXOpen.Features.RotatingPointerBuilder
#### NXOpen.Features.RotatingPointerListItemBuilder
#### NXOpen.Features.RPOBuilder
#### NXOpen.Features.RuledBuilder
#### NXOpen.Features.ScaleBuilder
#### NXOpen.Features.ScaleCurveBuilder
#### NXOpen.Features.SectionCurveBuilder
#### NXOpen.Features.SectionEditBuilder
#### NXOpen.Features.SectionInertiaAnalysisBuilder
#### NXOpen.Features.SectionSurfaceBuilder
#### NXOpen.Features.SelectionProgramAdjacentBuilder
#### NXOpen.Features.SelectionProgramBetweenBuilder
#### NXOpen.Features.SelectionProgramClosestBuilder
#### NXOpen.Features.SelectionProgramDirectionFromBuilder
#### NXOpen.Features.SelectionProgramFarthestBuilder
#### NXOpen.Features.SelectionProgramFeatureBuilder
#### NXOpen.Features.SelectionProgramInsideBodyBuilder
#### NXOpen.Features.SelectionProgramIntersectedByBuilder
#### NXOpen.Features.SelectionProgramListItemBuilder
#### NXOpen.Features.SelectionProgramMainBuilder
#### NXOpen.Features.SelectionProgramObjectTypeBuilder
#### NXOpen.Features.SelectionProgramPiercedByBuilder
#### NXOpen.Features.SelectionProgramRegionFacesBuilder
#### NXOpen.Features.ServiceOrientedBodyFeatureBuilder
#### NXOpen.Features.ServiceOrientedFeatureCurveBuilder
#### NXOpen.Features.SetOfPointsOnCurveBuilder
#### NXOpen.Features.SewBuilder
#### NXOpen.Features.ShadowCurveBuilder
#### NXOpen.Features.ShelfBuilder
#### NXOpen.Features.ShellBuilder
#### NXOpen.Features.ShellFaceBuilder
#### NXOpen.Features.ShowRelatedFacesBuilder
#### NXOpen.Features.SilhouetteFlangeBuilder
#### NXOpen.Features.SimplifyCurveBuilder
#### NXOpen.Features.SketchFitCurveBuilder
#### NXOpen.Features.SketchSplineBuilder
#### NXOpen.Features.SmoothCurveStringBuilder
#### NXOpen.Features.SmoothRangeBuilder
#### NXOpen.Features.SmoothSplineBuilder
#### NXOpen.Features.SnipSurfaceBuilder
#### NXOpen.Features.SphereBuilder
#### NXOpen.Features.SphericalCornerBuilder
#### NXOpen.Features.SpineCurveBuilder
#### NXOpen.Features.SplitBodyBuilder
#### NXOpen.Features.StepBuilder
#### NXOpen.Features.StepExpressionBuilder
#### NXOpen.Features.StiltsBuilder
#### NXOpen.Features.StudioSplineBuilder
#### NXOpen.Features.StudioSurfaceBuilder
#### NXOpen.Features.StyledBlendBuilder
#### NXOpen.Features.StyledCornerBuilder
#### NXOpen.Features.StyledSweepBuilder
#### NXOpen.Features.SweepAlongGuideBuilder
#### NXOpen.Features.SweptBuilder
#### NXOpen.Features.SweptVolumeBuilder
#### NXOpen.Features.SymmetricBuilder
#### NXOpen.Features.TabNoteCfgBuilder
#### NXOpen.Features.TangentBuilder
#### NXOpen.Features.TextBuilder
#### NXOpen.Features.TextureBuilder
#### NXOpen.Features.ThickenBuilder
#### NXOpen.Features.ThreadBuilder
#### NXOpen.Features.ThroughCurveMeshBuilder
#### NXOpen.Features.ThroughCurvesBuilder
#### NXOpen.Features.ToolingBoxBuilder
#### NXOpen.Features.TouchAnalysisBuilder
#### NXOpen.Features.TrimAndExtendBuilder
#### NXOpen.Features.TrimBody2Builder
#### NXOpen.Features.TrimBodyBuilder
#### NXOpen.Features.TrimCornerBuilder
#### NXOpen.Features.TrimCurve2Builder
#### NXOpen.Features.TrimCurveBuilder
#### NXOpen.Features.TrimExtendBuilder
#### NXOpen.Features.TrimSheetBuilder
#### NXOpen.Features.TrunkVolumeBuilder
#### NXOpen.Features.TubeBuilder
#### NXOpen.Features.TubeLatticeBuilder
#### NXOpen.Features.UnitCellEditorBuilder
#### NXOpen.Features.UnsewBuilder
#### NXOpen.Features.UntrimBuilder
#### NXOpen.Features.UserDefinedObjectFeatureBuilder
#### NXOpen.Features.VariableOffsetBuilder
#### NXOpen.Features.VariableRadiusPointsBuilder
#### NXOpen.Features.VarOffsetFaceBuilder
#### NXOpen.Features.VarsweepBuilder
#### NXOpen.Features.VDVCameraBuilder
#### NXOpen.Features.VDVCameraListItemBuilder
#### NXOpen.Features.VDVEnvironmentBuilder
#### NXOpen.Features.VDVMirrorBuilder
#### NXOpen.Features.VDVMirrorListItemBuilder
#### NXOpen.Features.ViewVolumeBuilder
#### NXOpen.Features.ViewVolumeListItemBuilder
#### NXOpen.Features.VirtualBlendEdgeBuilder
#### NXOpen.Features.VirtualCurveBuilder
#### NXOpen.Features.VolumetricAnalysisBuilder
#### NXOpen.Features.WaveDatumBuilder
#### NXOpen.Features.WaveInterfaceLinkerBuilder
#### NXOpen.Features.WaveLinkBuilder
#### NXOpen.Features.WavePointBuilder
#### NXOpen.Features.WaveRoutingBuilder
#### NXOpen.Features.WaveSketchBuilder
#### NXOpen.Features.WrapBuilder
#### NXOpen.Features.WrapGeometryBuilder
#### NXOpen.Features.VehicleDesign.AllAroundVisionBuilder
#### NXOpen.Features.VehicleDesign.APillarObstructionBuilder
#### NXOpen.Features.VehicleDesign.BaseDataBuilder
#### NXOpen.Features.VehicleDesign.BaseDataDriverBuilder
#### NXOpen.Features.VehicleDesign.BaseDataImportExportBuilder
#### NXOpen.Features.VehicleDesign.BaseDataLoadingBuilder
#### NXOpen.Features.VehicleDesign.BaseDataLoadingWheelBuilder
#### NXOpen.Features.VehicleDesign.BaseDataPassengerBuilder
#### NXOpen.Features.VehicleDesign.BaseDataSourceBuilder
#### NXOpen.Features.VehicleDesign.BaseDataWheelBuilder
#### NXOpen.Features.VehicleDesign.BumperPendulumBuilder
#### NXOpen.Features.VehicleDesign.CloseRangeBlindVolumeListItemBuilder
#### NXOpen.Features.VehicleDesign.CloseRangeCameraListItemBuilder
#### NXOpen.Features.VehicleDesign.CloseRangeDemoCylinderListItemBuilder
#### NXOpen.Features.VehicleDesign.CloseRangeVisibilityBuilder
#### NXOpen.Features.VehicleDesign.ConfigurationBuilder
#### NXOpen.Features.VehicleDesign.CrashBarrierBuilder
#### NXOpen.Features.VehicleDesign.CrashBarrierExpressionBuilder
#### NXOpen.Features.VehicleDesign.DirectFieldViewBuilder
#### NXOpen.Features.VehicleDesign.DynamicCurbBuilder
#### NXOpen.Features.VehicleDesign.EngineRollBuilder
#### NXOpen.Features.VehicleDesign.EyeDefinitionBuilder
#### NXOpen.Features.VehicleDesign.EyellipseBuilder
#### NXOpen.Features.VehicleDesign.GlassDropBuilder
#### NXOpen.Features.VehicleDesign.GlazingShadeBandsBuilder
#### NXOpen.Features.VehicleDesign.GroundClearanceBuilder
#### NXOpen.Features.VehicleDesign.HandReachBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactAPillarBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactAPillarDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactAPillarWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactBPillarBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactBPillarDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactBPillarWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactFrontHeaderBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactFrontHeaderDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactFrontHeaderWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactOPillarBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactOPillarDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactOPillarWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactOtherRailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactOtherRailDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactOtherRailWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactRearHeaderBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactRearHeaderDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactRearHeaderWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactRPillarBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactRPillarDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactRPillarWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactSideRailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactSideRailDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactSideRailWizardBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactUpperRoofBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactUpperRoofDetailBuilder
#### NXOpen.Features.VehicleDesign.HeadImpactUpperRoofWizardBuilder
#### NXOpen.Features.VehicleDesign.HoodVisibilityBuilder
#### NXOpen.Features.VehicleDesign.HPointDesignToolBuilder
#### NXOpen.Features.VehicleDesign.InnerAngleBuilder
#### NXOpen.Features.VehicleDesign.InstrumentPanelVisibilityBuilder
#### NXOpen.Features.VehicleDesign.ManikinBuilder
#### NXOpen.Features.VehicleDesign.ManikinModelBuilder
#### NXOpen.Features.VehicleDesign.MirrorCertificationBuilder
#### NXOpen.Features.VehicleDesign.OilPanBuilder
#### NXOpen.Features.VehicleDesign.PedestrianProtectionBuilder
#### NXOpen.Features.VehicleDesign.PendulumPlacementBuilder
#### NXOpen.Features.VehicleDesign.ReflectionDataBuilder
#### NXOpen.Features.VehicleDesign.SeatBeltAnchorageBuilder
#### NXOpen.Features.VehicleDesign.SeatLinesBuilder
#### NXOpen.Features.VehicleDesign.SectionViewBuilder
#### NXOpen.Features.VehicleDesign.SlopeBuilder
#### NXOpen.Features.VehicleDesign.StaticCurbBuilder
#### NXOpen.Features.VehicleDesign.StoneImpingementBuilder
#### NXOpen.Features.VehicleDesign.TireEnvelopeBuilder
#### NXOpen.Features.VehicleDesign.VehicleCoordinateSystemBuilder
#### NXOpen.Features.VehicleDesign.VisionPlaneBuilder
#### NXOpen.Features.VehicleDesign.WheelCoveringBuilder
#### NXOpen.Features.VehicleDesign.WheelFixingBuilder
#### NXOpen.Features.VehicleDesign.WindshieldDatumBuilder
#### NXOpen.Features.VehicleDesign.WindshieldVisionBuilder
#### NXOpen.Features.Subdivision.CageFromFacetBodyBuilder
#### NXOpen.Features.Subdivision.CagePolylineBuilder
#### NXOpen.Features.Subdivision.CopyCageBuilder
#### NXOpen.Features.Subdivision.DefineWorkRegionBuilder
#### NXOpen.Features.Subdivision.DeleteConstraintBuilder
#### NXOpen.Features.Subdivision.ExportSubdivisionGeometryBuilder
#### NXOpen.Features.Subdivision.ExtractCagePolylineBuilder
#### NXOpen.Features.Subdivision.ExtractVertexPointsBuilder
#### NXOpen.Features.Subdivision.ImportSubdivisionGeometryBuilder
#### NXOpen.Features.Subdivision.MergeSubdivisionBodiesBuilder
#### NXOpen.Features.Subdivision.MirrorCageBuilder
#### NXOpen.Features.Subdivision.OffsetCageBuilder
#### NXOpen.Features.Subdivision.SplitSubdivisionBodyBuilder
#### NXOpen.Features.Subdivision.StartSymmetricModelingBuilder
#### NXOpen.Features.Subdivision.SubdivisionBridgeFaceBuilder
#### NXOpen.Features.Subdivision.SubdivisionChamferCageBuilder
#### NXOpen.Features.Subdivision.SubdivisionConnectCageBuilder
#### NXOpen.Features.Subdivision.SubdivisionDeleteCageBuilder
#### NXOpen.Features.Subdivision.SubdivisionDeleteFaceBuilder
#### NXOpen.Features.Subdivision.SubdivisionDeleteObjectBuilder
#### NXOpen.Features.Subdivision.SubdivisionExtrudeCageBuilder
#### NXOpen.Features.Subdivision.SubdivisionFillBuilder
#### NXOpen.Features.Subdivision.SubdivisionLoftBuilder
#### NXOpen.Features.Subdivision.SubdivisionMergeFaceBuilder
#### NXOpen.Features.Subdivision.SubdivisionPrimitiveShapeBuilder
#### NXOpen.Features.Subdivision.SubdivisionProjectCageBuilder
#### NXOpen.Features.Subdivision.SubdivisionRevolveBuilder
#### NXOpen.Features.Subdivision.SubdivisionSetContinuityBuilder
#### NXOpen.Features.Subdivision.SubdivisionSetWeightBuilder
#### NXOpen.Features.Subdivision.SubdivisionSewCageBuilder
#### NXOpen.Features.Subdivision.SubdivisionSplitFaceBuilder
#### NXOpen.Features.Subdivision.SubdivisionSubdivideFaceBuilder
#### NXOpen.Features.Subdivision.SubdivisionSweepBuilder
#### NXOpen.Features.Subdivision.SubdivisionTubeBuilder
#### NXOpen.Features.StructureDesign.AddToWeldmentBuilder
#### NXOpen.Features.StructureDesign.AssignWeldingAttributesBuilder
#### NXOpen.Features.StructureDesign.BeamCurveBuilder
#### NXOpen.Features.StructureDesign.BeamPreparationBuilder
#### NXOpen.Features.StructureDesign.BoltedConnectionBuilder
#### NXOpen.Features.StructureDesign.ComponentDrawingBuilder
#### NXOpen.Features.StructureDesign.ConsolidateBuilder
#### NXOpen.Features.StructureDesign.ContainerBuilder
#### NXOpen.Features.StructureDesign.ContextAttributeBuilder
#### NXOpen.Features.StructureDesign.CornerNodeBuilder
#### NXOpen.Features.StructureDesign.CreateStructureBuilder
#### NXOpen.Features.StructureDesign.DiscoverFrame3DBuilder
#### NXOpen.Features.StructureDesign.DrawingsBuilder
#### NXOpen.Features.StructureDesign.EditCornerBuilder
#### NXOpen.Features.StructureDesign.EditStockBuilder
#### NXOpen.Features.StructureDesign.EditStructureBuilder
#### NXOpen.Features.StructureDesign.EndcapBuilder
#### NXOpen.Features.StructureDesign.ExportDSTVBuilder
#### NXOpen.Features.StructureDesign.ExtendMemberBuilder
#### NXOpen.Features.StructureDesign.FeatureParmsBuilder
#### NXOpen.Features.StructureDesign.FeatureSpreadsheetBuilder
#### NXOpen.Features.StructureDesign.Frame3DBuilder
#### NXOpen.Features.StructureDesign.Frame3DChamferBuilder
#### NXOpen.Features.StructureDesign.Frame3DCircleBuilder
#### NXOpen.Features.StructureDesign.Frame3DFilletBuilder
#### NXOpen.Features.StructureDesign.Frame3DGeometryBuilder
#### NXOpen.Features.StructureDesign.Frame3DQuickTrimExtendBuilder
#### NXOpen.Features.StructureDesign.Frame3DSettingsBuilder
#### NXOpen.Features.StructureDesign.FrameAssignMemberBuilder
#### NXOpen.Features.StructureDesign.FrameAssignRailBuilder
#### NXOpen.Features.StructureDesign.FrameCloneBuilder
#### NXOpen.Features.StructureDesign.FrameModifyMemberBuilder
#### NXOpen.Features.StructureDesign.FrameRemoveMemberBuilder
#### NXOpen.Features.StructureDesign.GrabTabBuilder
#### NXOpen.Features.StructureDesign.GussetBuilder
#### NXOpen.Features.StructureDesign.GussetConnectionBuilder
#### NXOpen.Features.StructureDesign.HandrailBuilder
#### NXOpen.Features.StructureDesign.HandrailSettingsBuilder
#### NXOpen.Features.StructureDesign.HandrailYOffsetBuilder
#### NXOpen.Features.StructureDesign.HandrailYOffsetListItemBuilder
#### NXOpen.Features.StructureDesign.HaunchBuilder
#### NXOpen.Features.StructureDesign.InheritFromCornerBuilder
#### NXOpen.Features.StructureDesign.InheritStockBuilder
#### NXOpen.Features.StructureDesign.LibraryBuilder
#### NXOpen.Features.StructureDesign.MemberBuilder
#### NXOpen.Features.StructureDesign.MemberPathBuilder
#### NXOpen.Features.StructureDesign.MirrorFeatureBuilder
#### NXOpen.Features.StructureDesign.MoveToContainerBuilder
#### NXOpen.Features.StructureDesign.NavigatorNodeBuilder
#### NXOpen.Features.StructureDesign.PadBuilder
#### NXOpen.Features.StructureDesign.PatternSettingsBuilder
#### NXOpen.Features.StructureDesign.PlateBuilder
#### NXOpen.Features.StructureDesign.PlateStockBuilder
#### NXOpen.Features.StructureDesign.PlatformBuilder
#### NXOpen.Features.StructureDesign.PlatformSettingsBuilder
#### NXOpen.Features.StructureDesign.RailBuilder
#### NXOpen.Features.StructureDesign.RuleBuilder
#### NXOpen.Features.StructureDesign.SplitFrame3DBuilder
#### NXOpen.Features.StructureDesign.SplitRailBuilder
#### NXOpen.Features.StructureDesign.StiffenerBuilder
#### NXOpen.Features.StructureDesign.SuperFrameBuilder
#### NXOpen.Features.ShipDesign.AddDataSetBuilder
#### NXOpen.Features.ShipDesign.AddStockItemToLibraryBuilder
#### NXOpen.Features.ShipDesign.AlongGuideCutBuilder
#### NXOpen.Features.ShipDesign.AssemblyDrawingBuilder
#### NXOpen.Features.ShipDesign.AssemblyViewBuilder
#### NXOpen.Features.ShipDesign.AssociativeMirrorBuilder
#### NXOpen.Features.ShipDesign.AssociativeMirrorPartBuilder
#### NXOpen.Features.ShipDesign.BlockAssignmentBuilder
#### NXOpen.Features.ShipDesign.BracketBoundaryBuilder
#### NXOpen.Features.ShipDesign.BracketBuilder
#### NXOpen.Features.ShipDesign.BuiltUpBlockBuilder
#### NXOpen.Features.ShipDesign.BuiltUpManModeBuilder
#### NXOpen.Features.ShipDesign.BuiltUpOffsetBuilder
#### NXOpen.Features.ShipDesign.BulkHeadListItemBuilder
#### NXOpen.Features.ShipDesign.BulkHeadsBuilder
#### NXOpen.Features.ShipDesign.CarlingPathBuilder
#### NXOpen.Features.ShipDesign.ChamferLineBuilder
#### NXOpen.Features.ShipDesign.CloneWeldsBuilder
#### NXOpen.Features.ShipDesign.CollarPlateBuilder
#### NXOpen.Features.ShipDesign.CompareModeBuilder
#### NXOpen.Features.ShipDesign.CompartmentBuilder
#### NXOpen.Features.ShipDesign.ConceptFromSpreadsheetBuilder
#### NXOpen.Features.ShipDesign.ConfigurableReportBuilder
#### NXOpen.Features.ShipDesign.CopyObjectsBuilder
#### NXOpen.Features.ShipDesign.CopyPasteNewBuilder
#### NXOpen.Features.ShipDesign.CornerCutBuilder
#### NXOpen.Features.ShipDesign.CornerCutListItemBuilder
#### NXOpen.Features.ShipDesign.CustomBracketBuilder
#### NXOpen.Features.ShipDesign.Cutout2Builder
#### NXOpen.Features.ShipDesign.CuttingSideFacesBuilder
#### NXOpen.Features.ShipDesign.DeckBuilder
#### NXOpen.Features.ShipDesign.DeckListBuilder
#### NXOpen.Features.ShipDesign.DeckListItemBuilder
#### NXOpen.Features.ShipDesign.DecksBuilder
#### NXOpen.Features.ShipDesign.DeleteSeamBuilder
#### NXOpen.Features.ShipDesign.DetailEditBoundaryBuilder
#### NXOpen.Features.ShipDesign.DisplaySolidBuilder
#### NXOpen.Features.ShipDesign.DivideBuilder
#### NXOpen.Features.ShipDesign.DrawingAnnotationBuilder
#### NXOpen.Features.ShipDesign.DrawingPartBuilder
#### NXOpen.Features.ShipDesign.DrawingSheetBuilder
#### NXOpen.Features.ShipDesign.DrawingTemplateBuilder
#### NXOpen.Features.ShipDesign.DvToMvMappingBuilder
#### NXOpen.Features.ShipDesign.EdgeCutBuilder
#### NXOpen.Features.ShipDesign.EdgeCutIntervalBuilder
#### NXOpen.Features.ShipDesign.EdgeCutIntervalListItemBuilder
#### NXOpen.Features.ShipDesign.EdgeReinforcementBuilder
#### NXOpen.Features.ShipDesign.EditBoundaryBuilder
#### NXOpen.Features.ShipDesign.EditContextAttributesBuilder
#### NXOpen.Features.ShipDesign.EditScantlingTableBuilder
#### NXOpen.Features.ShipDesign.EditStockBuilder
#### NXOpen.Features.ShipDesign.EditWeldingBuilder
#### NXOpen.Features.ShipDesign.EndCutBuilder
#### NXOpen.Features.ShipDesign.ExamineSteelFeatureBuilder
#### NXOpen.Features.ShipDesign.ExcessMaterialBuilder
#### NXOpen.Features.ShipDesign.ExpansionDrawingBuilder
#### NXOpen.Features.ShipDesign.ExportStructureXMLBuilder
#### NXOpen.Features.ShipDesign.ExtractGridBuilder
#### NXOpen.Features.ShipDesign.FeatureBodySymmetryBuilder
#### NXOpen.Features.ShipDesign.FeatureParmsBuilder
#### NXOpen.Features.ShipDesign.FeaturesBatchOperationBuilder
#### NXOpen.Features.ShipDesign.FeaturesToTagBuilder
#### NXOpen.Features.ShipDesign.FilterBuilder
#### NXOpen.Features.ShipDesign.FrameBarOutBuilder
#### NXOpen.Features.ShipDesign.FramePlusDistanceBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangementViewBuilder
#### NXOpen.Features.ShipDesign.GenerateLabelsBuilder
#### NXOpen.Features.ShipDesign.GenericPlateSystemBuilder
#### NXOpen.Features.ShipDesign.GlobalNestingBuilder
#### NXOpen.Features.ShipDesign.HullBuilder
#### NXOpen.Features.ShipDesign.ImportStructureXMLBuilder
#### NXOpen.Features.ShipDesign.InquireNestingBuilder
#### NXOpen.Features.ShipDesign.InsertFramesBuilder
#### NXOpen.Features.ShipDesign.InsertSheetBodyBuilder
#### NXOpen.Features.ShipDesign.InteractiveAnnotationBuilder
#### NXOpen.Features.ShipDesign.InteractiveAnnotationDeckBulkheadBuilder
#### NXOpen.Features.ShipDesign.InteractiveAnnotationReferenceLinesBuilder
#### NXOpen.Features.ShipDesign.InteractiveAnnotationSubBaseBuilder
#### NXOpen.Features.ShipDesign.InteractiveAnnotationTableBuilder
#### NXOpen.Features.ShipDesign.IntersectionElementBuilder
#### NXOpen.Features.ShipDesign.InverseBendingLinesBuilder
#### NXOpen.Features.ShipDesign.ItFrameListItemBuilder
#### NXOpen.Features.ShipDesign.ItFramesBuilder
#### NXOpen.Features.ShipDesign.KnuckledProfilesBuilder
#### NXOpen.Features.ShipDesign.LabellingRoomsBuilder
#### NXOpen.Features.ShipDesign.LimitBoxBuilder
#### NXOpen.Features.ShipDesign.LinesPlanBuilder
#### NXOpen.Features.ShipDesign.LongitudinalBulkheadBuilder
#### NXOpen.Features.ShipDesign.MainDimensionsBuilder
#### NXOpen.Features.ShipDesign.MainSurfacesBuilder
#### NXOpen.Features.ShipDesign.ManualReferencesBuilder
#### NXOpen.Features.ShipDesign.ManufacturingAssemblyNavigatorBuilder
#### NXOpen.Features.ShipDesign.ManufacturingDataBuilder
#### NXOpen.Features.ShipDesign.ManufacturingOutBuilder
#### NXOpen.Features.ShipDesign.ManufacturingPreparationBuilder
#### NXOpen.Features.ShipDesign.ManufacturingStockBuilder
#### NXOpen.Features.ShipDesign.MarkingLineBuilder
#### NXOpen.Features.ShipDesign.MarkingLineDesignBuilder
#### NXOpen.Features.ShipDesign.MarkInsulationAreaBuilder
#### NXOpen.Features.ShipDesign.MaterialAllowanceBuilder
#### NXOpen.Features.ShipDesign.MaterialEstimationBuilder
#### NXOpen.Features.ShipDesign.MfgCreateBuildingStrategyRootPartBuilder
#### NXOpen.Features.ShipDesign.MfgCreateSeveralContainersBuilder
#### NXOpen.Features.ShipDesign.MirrorShipStructureBuilder
#### NXOpen.Features.ShipDesign.MoveToContainerBuilder
#### NXOpen.Features.ShipDesign.NestingBuilder
#### NXOpen.Features.ShipDesign.NestingDrawingBuilder
#### NXOpen.Features.ShipDesign.NestingDxfOutputBuilder
#### NXOpen.Features.ShipDesign.NestingStockItemBuilder
#### NXOpen.Features.ShipDesign.NestingUpdateBuilder
#### NXOpen.Features.ShipDesign.NodeSelectionBuilder
#### NXOpen.Features.ShipDesign.OrientationAngleMethodsBuilder
#### NXOpen.Features.ShipDesign.OrientationDefinitionBuilder
#### NXOpen.Features.ShipDesign.OrientationPointMethodsBuilder
#### NXOpen.Features.ShipDesign.OrientationRegionItemBuilder
#### NXOpen.Features.ShipDesign.PenetrationAssociationBuilder
#### NXOpen.Features.ShipDesign.PenetrationCutoutBuilder
#### NXOpen.Features.ShipDesign.PenetrationRequestBuilder
#### NXOpen.Features.ShipDesign.PenetrationRequestForCutoutBuilder
#### NXOpen.Features.ShipDesign.PenetrationReviewRequestBuilder
#### NXOpen.Features.ShipDesign.PenetrationSaveRequestBuilder
#### NXOpen.Features.ShipDesign.PhysicalCompartmentBuilder
#### NXOpen.Features.ShipDesign.PillarBuilder
#### NXOpen.Features.ShipDesign.PillarSystemBuilder
#### NXOpen.Features.ShipDesign.PillarTreatmentBlockBuilder
#### NXOpen.Features.ShipDesign.PinJigBuilder
#### NXOpen.Features.ShipDesign.PinjigDrawingBuilder
#### NXOpen.Features.ShipDesign.PlaneListBuilder
#### NXOpen.Features.ShipDesign.PlanePairBuilder
#### NXOpen.Features.ShipDesign.PlateBoundaryOptionBuilder
#### NXOpen.Features.ShipDesign.PlateBuilder
#### NXOpen.Features.ShipDesign.PlateChamferBuilder
#### NXOpen.Features.ShipDesign.PlateDivideBuilder
#### NXOpen.Features.ShipDesign.PlatePlaneListBuilder
#### NXOpen.Features.ShipDesign.PlatePreparationBuilder
#### NXOpen.Features.ShipDesign.PlateStockBuilder
#### NXOpen.Features.ShipDesign.PlateStockEstimationBuilder
#### NXOpen.Features.ShipDesign.PlateSystemBuilder
#### NXOpen.Features.ShipDesign.PointDimBuilder
#### NXOpen.Features.ShipDesign.PointPairBuilder
#### NXOpen.Features.ShipDesign.ProfileBuilder
#### NXOpen.Features.ShipDesign.ProfileCutoutBuilder
#### NXOpen.Features.ShipDesign.ProfileListBuilder
#### NXOpen.Features.ShipDesign.ProfilePreparationBuilder
#### NXOpen.Features.ShipDesign.ProfileSketchBuilder
#### NXOpen.Features.ShipDesign.ProfileSystemBuilder
#### NXOpen.Features.ShipDesign.ProfileTransitionBuilder
#### NXOpen.Features.ShipDesign.ProjectSetupBuilder
#### NXOpen.Features.ShipDesign.PublishBuilder
#### NXOpen.Features.ShipDesign.QualifySketchBuilder
#### NXOpen.Features.ShipDesign.ReadDataSetBuilder
#### NXOpen.Features.ShipDesign.RebaseBuilder
#### NXOpen.Features.ShipDesign.ReferenceLineBuilder
#### NXOpen.Features.ShipDesign.RemoveSplitBuilder
#### NXOpen.Features.ShipDesign.ReverseSplitBuilder
#### NXOpen.Features.ShipDesign.RollingLineBuilder
#### NXOpen.Features.ShipDesign.RoomAttributeListBuilder
#### NXOpen.Features.ShipDesign.RoomAttributesBuilder
#### NXOpen.Features.ShipDesign.RoomBuilder
#### NXOpen.Features.ShipDesign.RoomPanelBuilder
#### NXOpen.Features.ShipDesign.RoomThicknessItemBuilder
#### NXOpen.Features.ShipDesign.ScantlingTableBuilder
#### NXOpen.Features.ShipDesign.SeamBlockBuilder
#### NXOpen.Features.ShipDesign.SeamBuilder
#### NXOpen.Features.ShipDesign.SectionBlockSelectionBuilder
#### NXOpen.Features.ShipDesign.SectionDrawingBuilder
#### NXOpen.Features.ShipDesign.SectionEditorBuilder
#### NXOpen.Features.ShipDesign.SectionViewBuilder
#### NXOpen.Features.ShipDesign.SelectPartBuilder
#### NXOpen.Features.ShipDesign.SelectStructuresBuilder
#### NXOpen.Features.ShipDesign.SelectViewBuilder
#### NXOpen.Features.ShipDesign.SetModeBuilder
#### NXOpen.Features.ShipDesign.ShellExpansionBuilder
#### NXOpen.Features.ShipDesign.ShellTemplateBuilder
#### NXOpen.Features.ShipDesign.ShipBlocksBuilder
#### NXOpen.Features.ShipDesign.ShipContainerBuilder
#### NXOpen.Features.ShipDesign.ShipCoordinatesBuilder
#### NXOpen.Features.ShipDesign.ShipCutoutBuilder
#### NXOpen.Features.ShipDesign.ShipDesignPreferencesBuilder
#### NXOpen.Features.ShipDesign.ShipDesignVersionUpBuilder
#### NXOpen.Features.ShipDesign.ShipEndCutBuilder
#### NXOpen.Features.ShipDesign.ShipGridBuilder
#### NXOpen.Features.ShipDesign.ShipIntersectionsBuilder
#### NXOpen.Features.ShipDesign.ShipNameFieldBuilder
#### NXOpen.Features.ShipDesign.ShipNamesBuilder
#### NXOpen.Features.ShipDesign.ShipNamesListBuilder
#### NXOpen.Features.ShipDesign.ShipPaintParametersBuilder
#### NXOpen.Features.ShipDesign.ShipPreparationBuilder
#### NXOpen.Features.ShipDesign.ShipPrimarySectionBuilder
#### NXOpen.Features.ShipDesign.ShipProfileCutoutBuilder
#### NXOpen.Features.ShipDesign.ShipSectionBuilder
#### NXOpen.Features.ShipDesign.ShipStructureBuilder
#### NXOpen.Features.ShipDesign.ShipTrimBodyBuilder
#### NXOpen.Features.ShipDesign.SmartRuleBuilder
#### NXOpen.Features.ShipDesign.SpatialBreakdownBuilder
#### NXOpen.Features.ShipDesign.SpatialBreakdownExportBuilder
#### NXOpen.Features.ShipDesign.SplitProfilePlateBuilder
#### NXOpen.Features.ShipDesign.SplitStandardPartBuilder
#### NXOpen.Features.ShipDesign.StabilityBuilder
#### NXOpen.Features.ShipDesign.StandardPartFrameworkBuilder
#### NXOpen.Features.ShipDesign.StandardPartItemBuilder
#### NXOpen.Features.ShipDesign.SteelCollarPlateBuilder
#### NXOpen.Features.ShipDesign.SteelDistributionBuilder
#### NXOpen.Features.ShipDesign.SteelFeatureSpreadsheetBuilder
#### NXOpen.Features.ShipDesign.SteelInsulationBoundaryBuilder
#### NXOpen.Features.ShipDesign.SteelInsulationBuilder
#### NXOpen.Features.ShipDesign.SteelSupportBuilder
#### NXOpen.Features.ShipDesign.SteelVentHolesBuilder
#### NXOpen.Features.ShipDesign.StiffenerBuilder
#### NXOpen.Features.ShipDesign.StiffenerBySupportPathBuilder
#### NXOpen.Features.ShipDesign.StiffenerLimitBuilder
#### NXOpen.Features.ShipDesign.StiffenerStockBuilder
#### NXOpen.Features.ShipDesign.StiffenerSystemBuilder
#### NXOpen.Features.ShipDesign.StockManagerBuilder
#### NXOpen.Features.ShipDesign.StructuralElementBuilder
#### NXOpen.Features.ShipDesign.StructuralElementCopyBuilder
#### NXOpen.Features.ShipDesign.StructuralElementCopyTargetListItemBuilder
#### NXOpen.Features.ShipDesign.StructuralElementIntersectedElementStaticBodyBuilder
#### NXOpen.Features.ShipDesign.StructuralElementIntersectedStiffenerBuilder
#### NXOpen.Features.ShipDesign.StructuralElementIntersectionLineBuilder
#### NXOpen.Features.ShipDesign.StructuralElementIntersectionLinesBuilder
#### NXOpen.Features.ShipDesign.StructuralElementIntersectionLineThicknessLineBuilder
#### NXOpen.Features.ShipDesign.StructuralElementsCheckOutOfDateBuilder
#### NXOpen.Features.ShipDesign.SubAssemblyDrawingBuilder
#### NXOpen.Features.ShipDesign.SubSystemBuilder
#### NXOpen.Features.ShipDesign.SubSystemsBuilder
#### NXOpen.Features.ShipDesign.SynchronizeDesignViewBuilder
#### NXOpen.Features.ShipDesign.ThicknessDirectionBuilder
#### NXOpen.Features.ShipDesign.TraceLinesBuilder
#### NXOpen.Features.ShipDesign.TransFrameBuilder
#### NXOpen.Features.ShipDesign.TransFrameListItemBuilder
#### NXOpen.Features.ShipDesign.TransitionBuilder
#### NXOpen.Features.ShipDesign.TransverseBulkheadBuilder
#### NXOpen.Features.ShipDesign.UnfoldedMinRecBuilder
#### NXOpen.Features.ShipDesign.UpdateProjectBuilder
#### NXOpen.Features.ShipDesign.UpdateShipLibraryBuilder
#### NXOpen.Features.ShipDesign.ValidateModelBuilder
#### NXOpen.Features.ShipDesign.VentHolesMarkingBuilder
#### NXOpen.Features.ShipDesign.VentilationHoles2Builder
#### NXOpen.Features.ShipDesign.VerifyPenetrationBuilder
#### NXOpen.Features.ShipDesign.WeightAndCGBuilder
#### NXOpen.Features.ShipDesign.WeldCut2Builder
#### NXOpen.Features.ShipDesign.WeldCutBuilder
#### NXOpen.Features.ShipDesign.YFrameBuilder
#### NXOpen.Features.ShipDesign.ZFrameBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangement.DrawingAutomationBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangement.DrawingItemBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangement.DrawingTableItemBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangement.DrawingViewItemBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangement.EvacuationPlanBuilder
#### NXOpen.Features.ShipDesign.GeneralArrangement.FaceCharacteristicsBuilder
#### NXOpen.Features.SheetMetal.AdvancedFlangeBuilder
#### NXOpen.Features.SheetMetal.AeroFlangeBuilder
#### NXOpen.Features.SheetMetal.AeroFlatPatternBuilder
#### NXOpen.Features.SheetMetal.AeroFlatSolidBuilder
#### NXOpen.Features.SheetMetal.AeroJoggleBuilder
#### NXOpen.Features.SheetMetal.AeroLighteningCutoutBuilder
#### NXOpen.Features.SheetMetal.AeroReformBuilder
#### NXOpen.Features.SheetMetal.AeroUnformBuilder
#### NXOpen.Features.SheetMetal.AssociateObjectBuilder
#### NXOpen.Features.SheetMetal.AssociateObjectInputListItemBuilder
#### NXOpen.Features.SheetMetal.BeadBuilder
#### NXOpen.Features.SheetMetal.BendBuilder
#### NXOpen.Features.SheetMetal.BendListBuilder
#### NXOpen.Features.SheetMetal.BendListItemBuilder
#### NXOpen.Features.SheetMetal.BendTaperBuilder
#### NXOpen.Features.SheetMetal.BreakCornerBuilder
#### NXOpen.Features.SheetMetal.BridgeTransitionBuilder
#### NXOpen.Features.SheetMetal.BulgeReliefBuilder
#### NXOpen.Features.SheetMetal.CleanUpUtilityBuilder
#### NXOpen.Features.SheetMetal.CleanUpUtilityListItemBuilder
#### NXOpen.Features.SheetMetal.ClosedCornerBuilder
#### NXOpen.Features.SheetMetal.ContourFlangeBuilder
#### NXOpen.Features.SheetMetal.ConvertInputListItemBuilder
#### NXOpen.Features.SheetMetal.ConvertToSheetmetalBuilder
#### NXOpen.Features.SheetMetal.CornerTreatmentBuilder
#### NXOpen.Features.SheetMetal.DimpleBuilder
#### NXOpen.Features.SheetMetal.DrawnCutoutBuilder
#### NXOpen.Features.SheetMetal.EdgeRipBuilder
#### NXOpen.Features.SheetMetal.ExportFlatPatternBuilder
#### NXOpen.Features.SheetMetal.FeatureBendPropertiesBuilder
#### NXOpen.Features.SheetMetal.FeatureBendPropertiesListBuilder
#### NXOpen.Features.SheetMetal.FlangeBendPropertiesBuilder
#### NXOpen.Features.SheetMetal.FlangeBendPropertiesListBuilder
#### NXOpen.Features.SheetMetal.FlangeBuilder
#### NXOpen.Features.SheetMetal.FlatPatternBuilder
#### NXOpen.Features.SheetMetal.FlatSolidBuilder
#### NXOpen.Features.SheetMetal.FlexibleCableBuilder
#### NXOpen.Features.SheetMetal.FlexTransitionAttachmentListItemBuilder
#### NXOpen.Features.SheetMetal.GussetBuilder
#### NXOpen.Features.SheetMetal.HemFlangeBuilder
#### NXOpen.Features.SheetMetal.HoleTreatmentBuilder
#### NXOpen.Features.SheetMetal.JogBuilder
#### NXOpen.Features.SheetMetal.JoggleBuilder
#### NXOpen.Features.SheetMetal.JoggleInputListItemBuilder
#### NXOpen.Features.SheetMetal.JoggleSideOptionsBuilder
#### NXOpen.Features.SheetMetal.LighteningCutoutBuilder
#### NXOpen.Features.SheetMetal.LoftedFlangeBuilder
#### NXOpen.Features.SheetMetal.LouverBuilder
#### NXOpen.Features.SheetMetal.MetaformBuilder
#### NXOpen.Features.SheetMetal.MigratedPanelBuilder
#### NXOpen.Features.SheetMetal.MultiBendBendPropertiesBuilder
#### NXOpen.Features.SheetMetal.MultiBendBendPropertiesListBuilder
#### NXOpen.Features.SheetMetal.MultiFlangeBuilder
#### NXOpen.Features.SheetMetal.MultiThicknessBuilder
#### NXOpen.Features.SheetMetal.MultiThicknessWrapPropertiesListItemBuilder
#### NXOpen.Features.SheetMetal.NestingBuilder
#### NXOpen.Features.SheetMetal.NormalCutoutBuilder
#### NXOpen.Features.SheetMetal.RebendBuilder
#### NXOpen.Features.SheetMetal.RemoveBendsBuilder
#### NXOpen.Features.SheetMetal.ResizeBendAngleBuilder
#### NXOpen.Features.SheetMetal.ResizeBendRadiusBuilder
#### NXOpen.Features.SheetMetal.ResizeNeutralFactorBuilder
#### NXOpen.Features.SheetMetal.SheetmetalBaseBuilder
#### NXOpen.Features.SheetMetal.SheetmetalComponentBuilder
#### NXOpen.Features.SheetMetal.SheetMetalFromSolidBendPropertiesBuilder
#### NXOpen.Features.SheetMetal.SheetMetalFromSolidBuilder
#### NXOpen.Features.SheetMetal.SMBoundaryConditionBuilder
#### NXOpen.Features.SheetMetal.SolidPunchBuilder
#### NXOpen.Features.SheetMetal.TabBuilder
#### NXOpen.Features.SheetMetal.ThreeBendCornerBuilder
#### NXOpen.Features.SheetMetal.UnbendBuilder
#### NXOpen.Features.SheetMetal.VariationalFlangeBuilder
#### NXOpen.Features.Industry.SectionFeatureSpreadsheetBuilder
#### NXOpen.Features.Industry.SelectProjectLoadFromBuilder
#### NXOpen.Features.DrawShapes.DivideBuilder
#### NXOpen.Features.DrawShapes.EditCurveBuilder
#### NXOpen.Features.DrawShapes.EditDisplayBuilder
#### NXOpen.Features.DrawShapes.EraseBuilder
#### NXOpen.Features.DrawShapes.ExtendBuilder
#### NXOpen.Features.DrawShapes.FilletBuilder
#### NXOpen.Features.DrawShapes.IntersectionCurveBuilder
#### NXOpen.Features.DrawShapes.ProjectCurveBuilder
#### NXOpen.Features.DrawShapes.StartSymmetryModeBuilder
#### NXOpen.Features.DrawShapes.TrimBuilder
#### NXOpen.Features.AECDesign.AddReusablePartBuilder
#### NXOpen.Features.AECDesign.AlternateCoverThicknessBuilder
#### NXOpen.Features.AECDesign.AlternateCoverThicknessListItemBuilder
#### NXOpen.Features.AECDesign.BaseDetailItemBuilder
#### NXOpen.Features.AECDesign.BaseLibraryItemBuilder
#### NXOpen.Features.AECDesign.BeamBuilder
#### NXOpen.Features.AECDesign.BIMClassificationBuilder
#### NXOpen.Features.AECDesign.BIMSlopeBuilder
#### NXOpen.Features.AECDesign.BoundaryOffsetBuilder
#### NXOpen.Features.AECDesign.BoundaryOffsetListItemBuilder
#### NXOpen.Features.AECDesign.BuildingElementTrimBuilder
#### NXOpen.Features.AECDesign.CeilingBuilder
#### NXOpen.Features.AECDesign.ColumnBuilder
#### NXOpen.Features.AECDesign.ConcreteRebarAnnotationBuilder
#### NXOpen.Features.AECDesign.CrossingRebarsBuilder
#### NXOpen.Features.AECDesign.ExplodeComponentBuilder
#### NXOpen.Features.AECDesign.ExtendToRoofBuilder
#### NXOpen.Features.AECDesign.FloorBuilder
#### NXOpen.Features.AECDesign.GridArcBuilder
#### NXOpen.Features.AECDesign.GridBuilder
#### NXOpen.Features.AECDesign.GridLineBuilder
#### NXOpen.Features.AECDesign.GridLineNoteBuilder
#### NXOpen.Features.AECDesign.GridLineOffsetBuilder
#### NXOpen.Features.AECDesign.GridLinePreferencesBuilder
#### NXOpen.Features.AECDesign.IFCPropertiesBuilder
#### NXOpen.Features.AECDesign.LabellingRoomsBuilder
#### NXOpen.Features.AECDesign.LevelBuilder
#### NXOpen.Features.AECDesign.LevelLineBuilder
#### NXOpen.Features.AECDesign.LevelLineNoteBuilder
#### NXOpen.Features.AECDesign.LevelLinePreferencesBuilder
#### NXOpen.Features.AECDesign.LevelPartsBuilder
#### NXOpen.Features.AECDesign.LevelReferenceBuilder
#### NXOpen.Features.AECDesign.LibraryManagerBuilder
#### NXOpen.Features.AECDesign.LongitudinalRebarsBuilder
#### NXOpen.Features.AECDesign.MaterialDataContainerBuilder
#### NXOpen.Features.AECDesign.MaterialLayerDetailBuilder
#### NXOpen.Features.AECDesign.MaterialLayerDetailItemBuilder
#### NXOpen.Features.AECDesign.MaterialLayersBuilder
#### NXOpen.Features.AECDesign.MaterialRailingBuilder
#### NXOpen.Features.AECDesign.MaterialRailingDetailBuilder
#### NXOpen.Features.AECDesign.MaterialRailingDetailItemBuilder
#### NXOpen.Features.AECDesign.MaterialSectionBuilder
#### NXOpen.Features.AECDesign.MaterialSectionDetailBuilder
#### NXOpen.Features.AECDesign.MaterialSectionDetailItemBuilder
#### NXOpen.Features.AECDesign.MaterialStairBuilder
#### NXOpen.Features.AECDesign.MaterialStairDetailBuilder
#### NXOpen.Features.AECDesign.MaterialStairDetailItemBuilder
#### NXOpen.Features.AECDesign.MaterialStairDetailItemStringerBuilder
#### NXOpen.Features.AECDesign.MaterialVisualItemBuilder
#### NXOpen.Features.AECDesign.OpeningBuilder
#### NXOpen.Features.AECDesign.PickCurveBuilder
#### NXOpen.Features.AECDesign.ProjectSetupBuilder
#### NXOpen.Features.AECDesign.RailingBuilder
#### NXOpen.Features.AECDesign.RebarBendingExportBuilder
#### NXOpen.Features.AECDesign.RebarHookBlockBuilder
#### NXOpen.Features.AECDesign.RebarLimitBuilder
#### NXOpen.Features.AECDesign.RebarsBuilder
#### NXOpen.Features.AECDesign.RoofBoundaryListItemBuilder
#### NXOpen.Features.AECDesign.RoofBuilder
#### NXOpen.Features.AECDesign.RoomAttributeListBuilder
#### NXOpen.Features.AECDesign.RoomBuilder
#### NXOpen.Features.AECDesign.RoomFaceListItemBuilder
#### NXOpen.Features.AECDesign.RoomReportBuilder
#### NXOpen.Features.AECDesign.SectionFeatureSpreadsheetBuilder
#### NXOpen.Features.AECDesign.StairBuilder
#### NXOpen.Features.AECDesign.WallBuilder
#### NXOpen.GeometricUtilities.AlignmentMethodBuilder
#### NXOpen.GeometricUtilities.AlongSpineBuilder
#### NXOpen.GeometricUtilities.AnchorLocatorBuilder
#### NXOpen.GeometricUtilities.AttributeHolderBuilder
#### NXOpen.GeometricUtilities.BlendSetbackBuilder
#### NXOpen.GeometricUtilities.BlendStopshortBuilder
#### NXOpen.GeometricUtilities.BlendStopshortBuilderCollection
#### NXOpen.GeometricUtilities.BodyCompareBuilder
#### NXOpen.GeometricUtilities.BooleanToolBuilder
#### NXOpen.GeometricUtilities.BoundaryDefinitionBuilder
#### NXOpen.GeometricUtilities.BoundingObjectBuilder
#### NXOpen.GeometricUtilities.ChamferEdgeChainSetBuilder
#### NXOpen.GeometricUtilities.CircularFrameBuilder
#### NXOpen.GeometricUtilities.CollectorPairBuilder
#### NXOpen.GeometricUtilities.CollectorPairListBuilder
#### NXOpen.GeometricUtilities.ColorCodedRegionBuilder
#### NXOpen.GeometricUtilities.CombOptionsBuilder
#### NXOpen.GeometricUtilities.ConvertFeatureGroupsToDesignGroupsBuilder
#### NXOpen.GeometricUtilities.ConvertFeatureGroupsToModulesBuilder
#### NXOpen.GeometricUtilities.CurveAlignedItemBuilder
#### NXOpen.GeometricUtilities.CurveAlignedListBuilder
#### NXOpen.GeometricUtilities.CurveExtensionBuilder
#### NXOpen.GeometricUtilities.CurveLengthBuilder
#### NXOpen.GeometricUtilities.CurveRangeBuilder
#### NXOpen.GeometricUtilities.CurveShapingBuilder
#### NXOpen.GeometricUtilities.DegreesAndSegmentsOrPatchesBuilder
#### NXOpen.GeometricUtilities.DepthSkewBuilder
#### NXOpen.GeometricUtilities.DisplayResolutionBuilder
#### NXOpen.GeometricUtilities.ExtrudeRevolveToolBuilder
#### NXOpen.GeometricUtilities.FacePairingBuilder
#### NXOpen.GeometricUtilities.FacePlaneSelectionBuilder
#### NXOpen.GeometricUtilities.FacePlaneSelectionBuilderCollection
#### NXOpen.GeometricUtilities.FacePlaneToolBuilder
#### NXOpen.GeometricUtilities.FaceSetDataCollection
#### NXOpen.GeometricUtilities.FaceSetOffsetCollection
#### NXOpen.GeometricUtilities.FrameOnPathBuilder
#### NXOpen.GeometricUtilities.FtmFixedCurvesBuilder
#### NXOpen.GeometricUtilities.FtmTransformCurvesBuilder
#### NXOpen.GeometricUtilities.FtmTransformPointsBuilder
#### NXOpen.GeometricUtilities.GeometryLocationDataCollection
#### NXOpen.GeometricUtilities.InteractiveSectionBuilder
#### NXOpen.GeometricUtilities.LatticeItemBuilder
#### NXOpen.GeometricUtilities.LatticeItemListBuilder
#### NXOpen.GeometricUtilities.LawBuilder
#### NXOpen.GeometricUtilities.LengthLimitPointBuilder
#### NXOpen.GeometricUtilities.LengthLimitsListBuilder
#### NXOpen.GeometricUtilities.LocalUntrimBuilder
#### NXOpen.GeometricUtilities.MatchSurfaceBuilder
#### NXOpen.GeometricUtilities.MovePoleBuilder
#### NXOpen.GeometricUtilities.MoveToGroupBuilder
#### NXOpen.GeometricUtilities.MultiTransitionLawBuilder
#### NXOpen.GeometricUtilities.NestModuleBuilder
#### NXOpen.GeometricUtilities.NonInflectingLawBuilder
#### NXOpen.GeometricUtilities.OnPathDimensionBuilder
#### NXOpen.GeometricUtilities.OnPathDimWithValueBuilder
#### NXOpen.GeometricUtilities.OrientationMethodBuilder
#### NXOpen.GeometricUtilities.OrientXpressBuilder
#### NXOpen.GeometricUtilities.PartModuleInputBuilder
#### NXOpen.GeometricUtilities.PartModuleOutputBuilder
#### NXOpen.GeometricUtilities.PartModuleReferencesBuilder
#### NXOpen.GeometricUtilities.PartModuleRelationshipBuilder
#### NXOpen.GeometricUtilities.PatternClockingBuilder
#### NXOpen.GeometricUtilities.PatternIncrementsBuilder
#### NXOpen.GeometricUtilities.PatternInstanceEditBuilder
#### NXOpen.GeometricUtilities.PatternReferencePointServiceBuilder
#### NXOpen.GeometricUtilities.PlayButtonsBuilder
#### NXOpen.GeometricUtilities.PointFacePlaneSelectionBuilder
#### NXOpen.GeometricUtilities.PointSetAlignmentBuilder
#### NXOpen.GeometricUtilities.PointsFromFileBuilder
#### NXOpen.GeometricUtilities.QuadrilateralFrameBuilder
#### NXOpen.GeometricUtilities.RectangularFrameBuilder
#### NXOpen.GeometricUtilities.ReduceSurfaceRadiusBuilder
#### NXOpen.GeometricUtilities.ReduceSurfaceRadiusFaceGroupBuilder
#### NXOpen.GeometricUtilities.RefitControlBuilder
#### NXOpen.GeometricUtilities.RenameLinkedPartModulePartBuilder
#### NXOpen.GeometricUtilities.RenewFeatureBuilder
#### NXOpen.GeometricUtilities.ReplaceManualMatchBuilder
#### NXOpen.GeometricUtilities.ReplAsstBuilder
#### NXOpen.GeometricUtilities.RodItemBuilder
#### NXOpen.GeometricUtilities.RodItemListBuilder
#### NXOpen.GeometricUtilities.RotationSetBuilder
#### NXOpen.GeometricUtilities.SaveConstraintsBuilder
#### NXOpen.GeometricUtilities.ScalingMethodBuilder
#### NXOpen.GeometricUtilities.ScalingSetBuilder
#### NXOpen.GeometricUtilities.SelectDividingObjectBuilder
#### NXOpen.GeometricUtilities.ShapeFrameBuilder
#### NXOpen.GeometricUtilities.SmartVolumeProfileBuilder
#### NXOpen.GeometricUtilities.SnipIntoPatchesBuilder
#### NXOpen.GeometricUtilities.SpineDefinitionBuilder
#### NXOpen.GeometricUtilities.SpinePlaneBuilder
#### NXOpen.GeometricUtilities.SpinePointDataCollection
#### NXOpen.GeometricUtilities.SplineExtensionBuilder
#### NXOpen.GeometricUtilities.SShapedLawBuilder
#### NXOpen.GeometricUtilities.StyledSweepDoubleOnPathDimBuilder
#### NXOpen.GeometricUtilities.StyledSweepReferenceMethodBuilder
#### NXOpen.GeometricUtilities.SurfaceRangeBuilder
#### NXOpen.GeometricUtilities.TangentMagnitudeBuilder
#### NXOpen.GeometricUtilities.TransitionCurveBuilder
#### NXOpen.GeometricUtilities.TransitionLawNodeBuilder
#### NXOpen.GeometricUtilities.TriangularFrameBuilder
#### NXOpen.GeometricUtilities.TrimCurveBoundingObjectBuilder
#### NXOpen.GeometricUtilities.UnitCellBuilder
#### NXOpen.GeometricUtilities.UnnestModuleBuilder
#### NXOpen.GeometricUtilities.VoronoiItemBuilder
#### NXOpen.GeometricUtilities.VoronoiItemListBuilder
#### NXOpen.GeometricUtilities.UVMapping.UVMappingCollection
#### NXOpen.GeometricUtilities.UVMapping.UVParameterizationBuilder
```

### A.3 Feature 特征类列表（共 339 个）

```text
AdaptiveShell  \[GetBodies\]
ADASCoordinateSystem  \[GetBodies\]
AddendumSection  \[GetBodies\]
AddendumSurface  \[GetBodies\]
AdmMoveFace  \[GetBodies\]
AdmOffsetRegion  \[GetBodies\]
AdmResizeFace  \[GetBodies\]
AeroFlange  \[GetBodies\]
AeroRib  \[GetBodies\]
AestheticFaceBlend  \[GetBodies\]
AnalyzePocket  \[GetBodies\]
AngularDim  \[GetBodies\]
AOCS  \[GetBodies\]
ApexRangeChamfer  \[GetBodies\]
AssemblyCut  \[GetBodies\]
AssociativeArc  \[GetBodies\]
AssociativeLine  \[GetBodies\]
Bead  \[GetBodies\]
Bend  \[GetBodies\]
BendTaper  \[GetBodies\]
BevelGear  \[GetBodies\]
BlendCorner  \[GetBodies\]
BlendCurveOnSurface  \[GetBodies\]
BlendPocket  \[GetBodies\]
Block  \[GetBodies\]
BodyByEquation  \[GetBodies\]
BodyFeature  \[GetBodies\]
BodyLattice  \[GetBodies\]
BodyLattice2  \[GetBodies\]
BooleanFeature  \[GetBodies\]
BoundedPlane  \[GetBodies\]
BreakCorner  \[GetBodies\]
Brep  \[GetBodies\]
BridgeCurve  \[GetBodies\]
BridgeSurface  \[GetBodies\]
BridgeTransition  \[GetBodies\]
Centerline  \[GetBodies\]
Chamfer  \[GetBodies\]
ChangeFace  \[GetBodies\]
ChangeShellThickness  \[GetBodies\]
CircularBlendCurve  \[GetBodies\]
ClipLattice  \[GetBodies\]
ClipLattice2  \[GetBodies\]
ClosedCorner  \[GetBodies\]
CMODTestFeature  \[GetBodies\]
Coaxial  \[GetBodies\]
CombineBodyFeature  \[GetBodies\]
CombinedProjection  \[GetBodies\]
CombinePattern  \[GetBodies\]
CombineSheets  \[GetBodies\]
CompensateRoughData  \[GetBodies\]
CompositeCurve  \[GetBodies\]
ConcaveFaces  \[GetBodies\]
Cone  \[GetBodies\]
ConnectDanglingRods  \[GetBodies\]
ConnectLattices2  \[GetBodies\]
ConnectLattices3  \[GetBodies\]
ContourFlange  \[GetBodies\]
ContourRib  \[GetBodies\]
ConvertToSheetmetal  \[GetBodies\]
Coplanar  \[GetBodies\]
CopyFace  \[GetBodies\]
CurveFeature  \[GetBodies\]
CurveLength  \[GetBodies\]
CurveOnSurface  \[GetBodies\]
CustomFeature  \[GetBodies\]
CutFace  \[GetBodies\]
Cylinder  \[GetBodies\]
CylinderGear  \[GetBodies\]
DatumAxisFeature  \[GetBodies\]
DatumCsys  \[GetBodies\]
DatumFeature  \[GetBodies\]
DatumPlaneFeature  \[GetBodies\]
DeleteBody  \[GetBodies\]
DeleteCurve  \[GetBodies\]
DeleteEdge  \[GetBodies\]
DeleteFace  \[GetBodies\]
DesignGroup  \[GetBodies\]
Dimple  \[GetBodies\]
DirectVision  \[GetBodies\]
Divideface  \[GetBodies\]
Draft  \[GetBodies\]
DraftBody  \[GetBodies\]
DrawDiePunch  \[GetBodies\]
DrawnCutout  \[GetBodies\]
DrawShape  \[GetBodies\]
EdgeBlend  \[GetBodies\]
EdgeRip  \[GetBodies\]
EdgeSymmetry  \[GetBodies\]
EditCrossSection  \[GetBodies\]
Emboss  \[GetBodies\]
EmbossBody  \[GetBodies\]
Enlarge  \[GetBodies\]
EnvironmentPainting  \[GetBodies\]
ExtendSheet  \[GetBodies\]
Extension  \[GetBodies\]
ExtractFace  \[GetBodies\]
Extrude  \[GetBodies\]
FaceBlend  \[GetBodies\]
FaceSheet  \[GetBodies\]
Feature  \[GetBodies\]
FeatureGroup  \[GetBodies\]
FillHole  \[GetBodies\]
FilterLattice2  \[GetBodies\]
FilterLattice3  \[GetBodies\]
FitCurve  \[GetBodies\]
FitSurface  \[GetBodies\]
Fixed  \[GetBodies\]
Flange  \[GetBodies\]
FlatPattern  \[GetBodies\]
FlatSolid  \[GetBodies\]
FlatteningAndForming  \[GetBodies\]
FlexibleCable  \[GetBodies\]
FlowBlend  \[GetBodies\]
FreeformUnform  \[GetBodies\]
FreeTransformer  \[GetBodies\]
GeneralConic  \[GetBodies\]
GeodesicChamfer  \[GetBodies\]
GeodesicFillet  \[GetBodies\]
GeodesicIntersect  \[GetBodies\]
GeodesicLine  \[GetBodies\]
GeodesicOffset  \[GetBodies\]
GeodesicPoint  \[GetBodies\]
GeodesicProject  \[GetBodies\]
GeodesicSketch  \[GetBodies\]
GeodesicTrim  \[GetBodies\]
Geomcopy  \[GetBodies\]
GlobalShaping  \[GetBodies\]
GridTarget  \[GetBodies\]
GroupBody  \[GetBodies\]
GroupEdge  \[GetBodies\]
GroupFace  \[GetBodies\]
GuidedExtensionEx  \[GetBodies\]
Gusset  \[GetBodies\]
HealSurface  \[GetBodies\]
Helix  \[GetBodies\]
HemFlange  \[GetBodies\]
Hole  \[GetBodies\]
HolePackage  \[GetBodies\]
Human  \[GetBodies\]
IdealizeGeometry  \[GetBodies\]
IForm  \[GetBodies\]
ImplicitModel  \[GetBodies\]
ImprintObject  \[GetBodies\]
InstanceFeature  \[GetBodies\]
Interception  \[GetBodies\]
IntersectionCurve  \[GetBodies\]
IsoclineCurve  \[GetBodies\]
IsolateFeature  \[GetBodies\]
IsoparametricCurves  \[GetBodies\]
Jog  \[GetBodies\]
JoinCurves  \[GetBodies\]
LabelChamfer  \[GetBodies\]
LabelNotchBlend  \[GetBodies\]
Lattice2  \[GetBodies\]
Lattice3  \[GetBodies\]
LawCurve  \[GetBodies\]
LawExtension  \[GetBodies\]
LawExtensionEx  \[GetBodies\]
LinearDimension  \[GetBodies\]
LinkedFacet  \[GetBodies\]
LinkLargeScaleGeometry  \[GetBodies\]
LocalScaleCurve  \[GetBodies\]
LoftedFlange  \[GetBodies\]
Louver  \[GetBodies\]
MakeOffset  \[GetBodies\]
MakeRuled  \[GetBodies\]
MakeSolid  \[GetBodies\]
ManufacturingAllowance  \[GetBodies\]
Maple  \[GetBodies\]
MasterCut  \[GetBodies\]
MatchEdge  \[GetBodies\]
MathIntegration  \[GetBodies\]
MeshSurface  \[GetBodies\]
MeshTransformer  \[GetBodies\]
Metaform  \[GetBodies\]
MidSurface  \[GetBodies\]
MidSurfaceByFacePairs  \[GetBodies\]
MidSurfaceByTwoSheets  \[GetBodies\]
MidSurfaceFacePair  \[GetBodies\]
MidSurfaceUserDefined  \[GetBodies\]
Mirror  \[GetBodies\]
MirrorBody  \[GetBodies\]
MirrorCurve  \[GetBodies\]
MirrorFace  \[GetBodies\]
MirrorFeature  \[GetBodies\]
MorphMesh  \[GetBodies\]
MoveBody  \[GetBodies\]
MoveCurve  \[GetBodies\]
MoveEdge  \[GetBodies\]
MoveFace  \[GetBodies\]
MoveObject  \[GetBodies\]
NormalCutout  \[GetBodies\]
NSidedSurface  \[GetBodies\]
Obstruction  \[GetBodies\]
Offset3DCurve  \[GetBodies\]
OffsetCurve  \[GetBodies\]
OffsetEdge  \[GetBodies\]
OffsetEmboss  \[GetBodies\]
OffsetFace  \[GetBodies\]
OffsetFacetBody  \[GetBodies\]
OffsetMoveCurve  \[GetBodies\]
OffsetRegion  \[GetBodies\]
OffsetSurface  \[GetBodies\]
Parallel  \[GetBodies\]
PartModule  \[GetBodies\]
PasteFace  \[GetBodies\]
Patch  \[GetBodies\]
PatchOpenings  \[GetBodies\]
PatternBody  \[GetBodies\]
PatternFace  \[GetBodies\]
PatternFaceFeature  \[GetBodies\]
PatternFeature  \[GetBodies\]
PatternGeometry  \[GetBodies\]
Perpendicular  \[GetBodies\]
PierceTask  \[GetBodies\]
PointFeature  \[GetBodies\]
PointSet  \[GetBodies\]
PoleSmoothing  \[GetBodies\]
Prebend  \[GetBodies\]
ProjectCurve  \[GetBodies\]
Promotion  \[GetBodies\]
PullFace  \[GetBodies\]
PunchThrough  \[GetBodies\]
QuickBinder  \[GetBodies\]
Rack  \[GetBodies\]
RadialDimension  \[GetBodies\]
RadiateFace  \[GetBodies\]
RapidSurface  \[GetBodies\]
RasterImage  \[GetBodies\]
Rebend  \[GetBodies\]
RefitFace  \[GetBodies\]
ReorderBlends  \[GetBodies\]
ReplaceBlend  \[GetBodies\]
ReplaceFace  \[GetBodies\]
ResizeBendAngle  \[GetBodies\]
ResizeBendRadius  \[GetBodies\]
ResizeBlend  \[GetBodies\]
ResizeChamfer  \[GetBodies\]
ResizeChamferCurve  \[GetBodies\]
ResizeCurve  \[GetBodies\]
ResizeFace  \[GetBodies\]
ResizeHole  \[GetBodies\]
ResizeNeutralFactor  \[GetBodies\]
ResizePattern  \[GetBodies\]
ResizePlane  \[GetBodies\]
Revolve  \[GetBodies\]
RevolveOutline  \[GetBodies\]
Rib  \[GetBodies\]
Ribbon  \[GetBodies\]
RodThickness  \[GetBodies\]
RodThickness2  \[GetBodies\]
RotatingPointer  \[GetBodies\]
Rotor  \[GetBodies\]
RPO  \[GetBodies\]
Ruled  \[GetBodies\]
Scale  \[GetBodies\]
ScaleCurve  \[GetBodies\]
SectionCurve  \[GetBodies\]
SectionInertiaAnalysis  \[GetBodies\]
SectionSurface  \[GetBodies\]
ServiceOrientedBodyFeature  \[GetBodies\]
ServiceOrientedFeatureCurve  \[GetBodies\]
Sew  \[GetBodies\]
ShadowCurve  \[GetBodies\]
SheetMetalFromSolid  \[GetBodies\]
Shelf  \[GetBodies\]
Shell  \[GetBodies\]
ShellFace  \[GetBodies\]
SilhouetteFlange  \[GetBodies\]
SimplifyCurve  \[GetBodies\]
SketchFeature  \[GetBodies\]
SmoothCurveString  \[GetBodies\]
SmoothSpline  \[GetBodies\]
SnipSurface  \[GetBodies\]
SoftBlend  \[GetBodies\]
SolidPunch  \[GetBodies\]
Sphere  \[GetBodies\]
SphericalCorner  \[GetBodies\]
SpineCurve  \[GetBodies\]
SplitBody  \[GetBodies\]
Step  \[GetBodies\]
Stilts  \[GetBodies\]
StudioSpline  \[GetBodies\]
StudioSurface  \[GetBodies\]
StudioSurfaceEx  \[GetBodies\]
StudioXform  \[GetBodies\]
StyledBlend  \[GetBodies\]
StyledCorner  \[GetBodies\]
StyledSweep  \[GetBodies\]
SweepAlongGuide  \[GetBodies\]
Swept  \[GetBodies\]
SweptVolume  \[GetBodies\]
Symmetric  \[GetBodies\]
Tab  \[GetBodies\]
Tangent  \[GetBodies\]
Text  \[GetBodies\]
Texture  \[GetBodies\]
Thicken  \[GetBodies\]
Thread  \[GetBodies\]
ThreeBendCorner  \[GetBodies\]
ThroughCurveMesh  \[GetBodies\]
ThroughCurves  \[GetBodies\]
ToolingBox  \[GetBodies\]
TopologyOptimizationFeature  \[GetBodies\]
TouchAnalysis  \[GetBodies\]
TrimAndExtend  \[GetBodies\]
TrimBody  \[GetBodies\]
TrimBody2  \[GetBodies\]
TrimCurve  \[GetBodies\]
TrimCurve2  \[GetBodies\]
TrimExtend  \[GetBodies\]
TrimLineDevelopment  \[GetBodies\]
TrimSheet  \[GetBodies\]
TrunkVolume  \[GetBodies\]
Tube  \[GetBodies\]
TubeLattice  \[GetBodies\]
Unbend  \[GetBodies\]
UniversalUnform  \[GetBodies\]
Unsew  \[GetBodies\]
Untrim  \[GetBodies\]
UserDefinedObjectFeature  \[GetBodies\]
VariableOffset  \[GetBodies\]
VarOffsetFace  \[GetBodies\]
Varsweep  \[GetBodies\]
VDVCamera  \[GetBodies\]
VDVEnvironment  \[GetBodies\]
VDVMirror  \[GetBodies\]
ViewVolume  \[GetBodies\]
VirtualCurve  \[GetBodies\]
VolumetricAnalysis  \[GetBodies\]
WaveDatum  \[GetBodies\]
WaveLink  \[GetBodies\]
WavePoint  \[GetBodies\]
WaveRouting  \[GetBodies\]
WaveSketch  \[GetBodies\]
WrapGeometry  \[GetBodies\]
WrapUnwrap  \[GetBodies\]
feature classes: 338
```

---
