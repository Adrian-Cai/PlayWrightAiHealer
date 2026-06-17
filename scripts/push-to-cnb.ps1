# cnb.cool push helper (updated per cnb.cool docs)
# 在你本机 PowerShell 里执行这段（不要贴给 AI）
#
# 步骤：
# 1. cnb.cool -> 个人设置 -> 访问令牌 -> 撤销旧的 playwright-ai-healer
# 2. 重新生成一个 token (勾 repository 权限)
# 3. 确认 cnb.cool 上仓库 playwright-ai-healer 已存在
# 4. 复制下面整段到 PowerShell 运行

Set-Location "C:\Users\ImAca\AllProject\playwright-ai-healer"

# 显示当前状态
Write-Host "=== Git config ===" -ForegroundColor Cyan
git config --local --get user.name
git config --local --get user.email
Write-Host "`n=== Remote ===" -ForegroundColor Cyan
git remote -v
Write-Host "`n=== Branches ===" -ForegroundColor Cyan
git branch -a
Write-Host "`n=== Latest commit ===" -ForegroundColor Cyan
git log --oneline -1

Write-Host "`n=== 准备 push ===" -ForegroundColor Yellow
Write-Host "remote URL: https://cnb.cool/ImAcaiy/playwright-ai-healer.git"
Write-Host "git username: Acaiy"
Write-Host "credential helper: store (会保存到 ~/.git-credentials, 第一次会提示输入)"
Write-Host ""

# 推 main 分支
git push -u origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ Push 成功！" -ForegroundColor Green
    Write-Host "查看: https://cnb.cool/ImAcaiy/playwright-ai-healer"
} else {
    Write-Host "`n❌ Push 失败 (exit $LASTEXITCODE)" -ForegroundColor Red
    Write-Host "常见原因："
    Write-Host "  1. token 复制不完整（要 40+ 字符、不含 <>）"
    Write-Host "  2. token 没勾 repository 权限"
    Write-Host "  3. 仓库未在 cnb.cool 创建"
    Write-Host "  4. 用户名大小写错了 (应该是 Acaiy)"
}
