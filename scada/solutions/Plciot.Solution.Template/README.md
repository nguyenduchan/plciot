# Plciot.Solution.Template — mẫu cho khách hàng mới

```bash
cp -r scada/solutions/Plciot.Solution.Template scada/solutions/Plciot.Solution.<TenKhach>
# đổi tên .csproj, namespace, TemplateSolution → <TenKhach>Solution, sửa Name
dotnet sln scada/Plciot.Scada.sln add scada/solutions/Plciot.Solution.<TenKhach>
dotnet run --project scada/solutions/Plciot.Solution.<TenKhach>
```
Quy tắc và hướng dẫn cho LLM: `scada/CLAUDE.md` và `docs/SCADA-FRAMEWORK.md`.
