pipeline {
    agent any

    environment {
        DEEPSEEK_API_KEY = credentials('DEEPSEEK_API_KEY')
        FEISHU_WEBHOOK_URL = credentials('FEISHU_WEBHOOK_URL')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm ci'
                sh 'npx playwright install chromium --with-deps'
            }
        }

        stage('Run Tests') {
            steps {
                sh 'npx playwright test'
            }
        }
    }

    post {
        always {
            publishHTML([allowMissing: false, alwaysLinkToLastBuild: true, keepAll: true, reportDir: 'playwright-report', reportFiles: 'index.html', reportName: 'Playwright Report', title: 'Playwright Report'])
        }
    }
}
