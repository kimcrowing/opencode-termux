# NX 2606 建模特征构建 API 全参考（反射实测 2026-09-13）

> 全部签名来自 **2606.3002 反射 dump 实录取证**（`~/usr/tmp/opencode/nx2606/_api_*.cs` 探针），
> 非文档转抄。供 MCP 工具调用 journal.run 构建特征时查用。
> 另有构建时实测坑（加粗标注），全部可复现。

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