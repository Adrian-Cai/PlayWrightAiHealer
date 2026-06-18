pipeline {
    agent {
        docker {
            image 'mcr.microsoft.com/playwright:v1.61.0-noble'
            args '-u root:root'
        }
    }

    environment {
        DEEPSEEK_API_KEY = credentials('DEEPSEEK_API_KEY')
        DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
        FEISHU_APP_ID = credentials('FEISHU_APP_ID')
        FEISHU_APP_SECRET = credentials('FEISHU_APP_SECRET')
        FEISHU_CHAT_ID = credentials('FEISHU_CHAT_ID')
        // 对外可访问的 Jenkins 根地址（需以 '/' 结尾）。BUILD_URL 取自 Jenkins Location 配置；
        // 若其指向内网/不可达主机（如 www.wiac.xyz:8080 → 502），可在 Jenkins 全局环境变量里设置
        // JENKINS_PUBLIC_URL 覆盖。最彻底的做法是把 Jenkins Location URL 改为正确地址（如 https://jenkins.wiac.xyz/）。
        // publishHTML reportName='Playwright_Report'，故对外报告地址拼接该路径；
        // 旧的 'playwright-report/' 是工作区目录，Jenkins 不会以 URL 提供 → 502。
        PLAYWRIGHT_REPORT_URL = "${env.JENKINS_PUBLIC_URL ?: env.BUILD_URL}Playwright_Report/"
        JENKINS_BUILD_URL = "${env.JENKINS_PUBLIC_URL ?: env.BUILD_URL}"
        RUN_ID = "${BUILD_ID}-${BUILD_TIMESTAMP}"
    }

    stages {
        stage('Checkout') {
            steps {
                // checkout scm 自动拉取触发构建的分支（包括 PR 分支）。
                // PR 自动触发需在 Jenkins job 配置里启用：
                //   - Multibranch Pipeline：自动发现 CNB 分支和 PR
                //   - 或在 CNB 仓库设置 → Webhook → 推送到 Jenkins Generic Webhook Trigger
                // Phase 4 闭环：飞书点"确认替换并提 PR" → CNB 出现 PR →
                // Jenkins 自动重跑测试 → 验证新 locator 有效 → 人工合并。
                checkout scm
            }
        }

        stage('Install Dependencies') {
            steps {
                // package-lock.json 已与 package.json 同步，ts-node 随 npm ci 一并安装，
                // 不再需要额外的 npm install --no-save ts-node
                sh 'npm ci'
            }
        }

        stage('Run Tests') {
            steps {
                sh 'npm run test:ci'
            }
        }
    }

    post {
        always {
            publishHTML([
                allowMissing: false,
                alwaysLinkToLastBuild: true,
                keepAll: true,
                reportDir: 'playwright-report',
                reportFiles: 'index.html',
                reportName: 'Playwright_Report'
            ])

            // Archive heal system artifacts
            // playwright-report/** 归档后可通过 ".../artifact/playwright-report/*zip*/playwright-report.zip" 下载，
            // 作为浏览器内 HTML 报告受 Jenkins CSP 限制白屏时的兜底查看方式（解压后本地打开 index.html）
            archiveArtifacts artifacts: 'healer-cache.json,test-results/ai-healer-events.jsonl,test-results/**/*,playwright-report/**', allowEmptyArchive: true

            // Clean up temp files
            sh 'rm -f healer-cache.json .heal-events.jsonl || true'
        }

        failure {
            // Keep artifacts on failure for investigation
            echo 'Tests failed. Healing artifacts preserved for analysis.'
        }
    }
}
